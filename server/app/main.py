from __future__ import annotations

import asyncio
import json
import os
import shutil
import time
import uuid
from contextlib import asynccontextmanager, suppress
from pathlib import Path
from typing import Any
from urllib.parse import unquote

from fastapi import FastAPI, HTTPException, Query, Request, status
from fastapi.responses import FileResponse, Response


DATA_DIR = Path(os.getenv("DATA_DIR", "/data/jobs"))
MAX_UPLOAD_BYTES = int(float(os.getenv("MAX_UPLOAD_GB", "12")) * 1024**3)
MIN_FREE_BYTES = int(float(os.getenv("MIN_FREE_GB", "5")) * 1024**3)
RETENTION_SECONDS = int(float(os.getenv("RETENTION_HOURS", "24")) * 3600)
MAX_CONCURRENT_JOBS = max(1, int(os.getenv("MAX_CONCURRENT_JOBS", "1")))

ALLOWED_EXTENSIONS = {"mp4", "mov", "avi", "mkv", "webm", "m4v", "mpeg", "mpg"}
ALLOWED_BITRATES = {128, 192, 256, 320}
FORMAT_CONFIG = {
    "mp3": {"args": ["-c:a", "libmp3lame"], "mime": "audio/mpeg"},
    "wav": {"args": ["-c:a", "pcm_s16le"], "mime": "audio/wav"},
    "m4a": {"args": ["-c:a", "aac", "-movflags", "+faststart"], "mime": "audio/mp4"},
    "ogg": {"args": ["-c:a", "libvorbis"], "mime": "audio/ogg"},
}

jobs: dict[str, dict[str, Any]] = {}
conversion_slots = asyncio.Semaphore(MAX_CONCURRENT_JOBS)
background_tasks: set[asyncio.Task[Any]] = set()


def now() -> int:
    return int(time.time())


def safe_name(filename: str) -> str:
    cleaned = "".join(
        char for char in filename if char.isalnum() or char in " ._-()"
    ).strip()
    return cleaned[:180] or "video"


def public_job(job: dict[str, Any]) -> dict[str, Any]:
    payload = {
        "id": job["id"],
        "status": job["status"],
        "progress": job.get("progress", 0),
        "format": job["format"],
        "original_name": job["original_name"],
        "input_size": job.get("input_size", 0),
        "created_at": job["created_at"],
        "updated_at": job["updated_at"],
    }
    if job.get("error"):
        payload["error"] = job["error"]
    if job["status"] == "ready":
        payload.update(
            output_name=job["output_name"],
            output_size=job["output_size"],
            download_url=f"/api/jobs/{job['id']}/download",
            expires_at=job["updated_at"] + RETENTION_SECONDS,
        )
    return payload


def persist(job: dict[str, Any]) -> None:
    job_dir = DATA_DIR / job["id"]
    job_dir.mkdir(parents=True, exist_ok=True)
    target = job_dir / "job.json"
    temporary = job_dir / "job.json.tmp"
    temporary.write_text(
        json.dumps(job, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    temporary.replace(target)


def remove_job_files(job_id: str) -> None:
    shutil.rmtree(DATA_DIR / job_id, ignore_errors=True)
    jobs.pop(job_id, None)


def load_jobs() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    for metadata in DATA_DIR.glob("*/job.json"):
        try:
            job = json.loads(metadata.read_text(encoding="utf-8"))
            if job["status"] in {"uploading", "queued", "converting"}:
                job["status"] = "error"
                job["error"] = (
                    "A conversão foi interrompida por uma reinicialização do servidor."
                )
                job["updated_at"] = now()
                persist(job)
            jobs[job["id"]] = job
        except (OSError, ValueError, KeyError):
            shutil.rmtree(metadata.parent, ignore_errors=True)


async def cleaner() -> None:
    while True:
        await asyncio.sleep(600)
        cutoff = now() - RETENTION_SECONDS
        for job_id, job in list(jobs.items()):
            if job["status"] in {"ready", "error"} and job["updated_at"] < cutoff:
                remove_job_files(job_id)


def track(task: asyncio.Task[Any]) -> None:
    background_tasks.add(task)
    task.add_done_callback(background_tasks.discard)


async def probe_duration(input_path: Path) -> float:
    process = await asyncio.create_subprocess_exec(
        "ffprobe",
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        str(input_path),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL,
    )
    stdout, _ = await asyncio.wait_for(process.communicate(), timeout=120)
    if process.returncode != 0:
        raise RuntimeError("Não foi possível ler a duração do vídeo.")
    return max(float(stdout.decode().strip()), 0.001)


async def convert_job(job_id: str) -> None:
    job = jobs[job_id]
    async with conversion_slots:
        input_path = Path(job["input_path"])
        output_path = Path(job["output_path"])
        log_path = input_path.parent / "ffmpeg.log"
        try:
            job.update(status="converting", progress=1, updated_at=now())
            persist(job)
            duration = await probe_duration(input_path)

            codec_args = list(FORMAT_CONFIG[job["format"]]["args"])
            if job["format"] != "wav":
                codec_args.extend(["-b:a", f"{job['bitrate']}k"])

            with log_path.open("wb") as log_file:
                process = await asyncio.create_subprocess_exec(
                    "ffmpeg",
                    "-y",
                    "-hide_banner",
                    "-nostdin",
                    "-i",
                    str(input_path),
                    "-vn",
                    *codec_args,
                    "-progress",
                    "pipe:1",
                    "-nostats",
                    str(output_path),
                    stdout=asyncio.subprocess.PIPE,
                    stderr=log_file,
                )
                assert process.stdout is not None
                async for raw_line in process.stdout:
                    line = raw_line.decode(errors="ignore").strip()
                    if line.startswith(("out_time_us=", "out_time_ms=")):
                        elapsed = int(line.split("=", 1)[1] or 0) / 1_000_000
                        progress = min(99, max(1, round(elapsed / duration * 100)))
                        if progress != job["progress"]:
                            job.update(progress=progress, updated_at=now())
                            persist(job)
                exit_code = await process.wait()

            if (
                exit_code != 0
                or not output_path.exists()
                or output_path.stat().st_size == 0
            ):
                raise RuntimeError(
                    "O FFmpeg não conseguiu extrair o áudio desse arquivo."
                )

            job.update(
                status="ready",
                progress=100,
                output_size=output_path.stat().st_size,
                updated_at=now(),
            )
            persist(job)
        except Exception as error:  # noqa: BLE001
            output_path.unlink(missing_ok=True)
            job.update(status="error", progress=0, error=str(error), updated_at=now())
            persist(job)
        finally:
            input_path.unlink(missing_ok=True)


@asynccontextmanager
async def lifespan(_: FastAPI):
    load_jobs()
    cleanup_task = asyncio.create_task(cleaner())
    try:
        yield
    finally:
        cleanup_task.cancel()
        with suppress(asyncio.CancelledError):
            await cleanup_task


app = FastAPI(
    title="Komanda F5 Converter API", docs_url=None, redoc_url=None, lifespan=lifespan
)


@app.get("/api/health")
async def health() -> dict[str, Any]:
    disk = shutil.disk_usage(DATA_DIR)
    return {
        "status": "ok",
        "free_bytes": disk.free,
        "active_jobs": sum(
            job["status"] in {"uploading", "queued", "converting"}
            for job in jobs.values()
        ),
        "max_upload_bytes": MAX_UPLOAD_BYTES,
    }


@app.post("/api/jobs", status_code=status.HTTP_202_ACCEPTED)
async def create_job(
    request: Request,
    output_format: str = Query(alias="format"),
    bitrate: int = Query(default=192),
) -> dict[str, Any]:
    output_format = output_format.lower()
    if output_format not in FORMAT_CONFIG:
        raise HTTPException(400, "Formato de saída inválido.")
    if output_format != "wav" and bitrate not in ALLOWED_BITRATES:
        raise HTTPException(400, "Bitrate inválido.")

    raw_name = unquote(request.headers.get("x-filename", "video.mp4"))
    original_name = safe_name(raw_name)
    extension = original_name.rsplit(".", 1)[-1].lower() if "." in original_name else ""
    if extension not in ALLOWED_EXTENSIONS:
        raise HTTPException(400, "Formato de vídeo não permitido.")

    content_length = request.headers.get("content-length")
    expected_size = (
        int(content_length) if content_length and content_length.isdigit() else 0
    )
    if expected_size > MAX_UPLOAD_BYTES:
        raise HTTPException(
            413, "O arquivo ultrapassa o limite configurado no servidor."
        )
    if shutil.disk_usage(DATA_DIR).free < expected_size + MIN_FREE_BYTES:
        raise HTTPException(
            507, "Não há espaço suficiente na VPS para receber este vídeo."
        )

    job_id = uuid.uuid4().hex
    job_dir = DATA_DIR / job_id
    job_dir.mkdir(parents=True)
    input_path = job_dir / f"input.{extension}"
    output_name = f"{safe_name(original_name.rsplit('.', 1)[0])}.{output_format}"
    output_path = job_dir / f"output.{output_format}"
    job: dict[str, Any] = {
        "id": job_id,
        "status": "uploading",
        "progress": 0,
        "format": output_format,
        "bitrate": bitrate,
        "original_name": original_name,
        "output_name": output_name,
        "input_path": str(input_path),
        "output_path": str(output_path),
        "input_size": 0,
        "created_at": now(),
        "updated_at": now(),
    }
    jobs[job_id] = job
    persist(job)

    received = 0
    next_disk_check = 64 * 1024**2
    try:
        with input_path.open("wb") as destination:
            async for chunk in request.stream():
                received += len(chunk)
                if received > MAX_UPLOAD_BYTES:
                    raise HTTPException(
                        413, "O arquivo ultrapassa o limite configurado no servidor."
                    )
                if received >= next_disk_check:
                    if shutil.disk_usage(DATA_DIR).free < MIN_FREE_BYTES:
                        raise HTTPException(
                            507, "O disco da VPS atingiu o limite de segurança."
                        )
                    next_disk_check += 64 * 1024**2
                destination.write(chunk)
        if received == 0:
            raise HTTPException(400, "O arquivo enviado está vazio.")
    except Exception:
        remove_job_files(job_id)
        raise

    job.update(status="queued", input_size=received, updated_at=now())
    persist(job)
    task = asyncio.create_task(convert_job(job_id))
    track(task)
    return public_job(job)


@app.get("/api/jobs/{job_id}")
async def get_job(job_id: str) -> dict[str, Any]:
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(404, "Conversão não encontrada ou já removida.")
    return public_job(job)


@app.get("/api/jobs/{job_id}/download")
async def download(job_id: str) -> FileResponse:
    job = jobs.get(job_id)
    if not job or job["status"] != "ready":
        raise HTTPException(404, "O áudio ainda não está disponível.")
    output_path = Path(job["output_path"])
    if not output_path.exists():
        raise HTTPException(404, "O arquivo já foi removido.")
    return FileResponse(
        output_path,
        filename=job["output_name"],
        media_type=FORMAT_CONFIG[job["format"]]["mime"],
    )


@app.delete(
    "/api/jobs/{job_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    response_class=Response,
)
async def delete_job(job_id: str) -> Response:
    job = jobs.get(job_id)
    if not job:
        raise HTTPException(404, "Conversão não encontrada.")
    if job["status"] in {"uploading", "queued", "converting"}:
        raise HTTPException(409, "A conversão ainda está em andamento.")
    remove_job_files(job_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
