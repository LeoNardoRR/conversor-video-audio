from __future__ import annotations

import asyncio
import hashlib
import ipaddress
import json
import os
import re
import shutil
import socket
import time
import uuid
from contextlib import asynccontextmanager, suppress
from html.parser import HTMLParser
from pathlib import Path
from typing import Any, Literal
from urllib.error import HTTPError, URLError
from urllib.parse import unquote, urljoin, urlparse
from urllib.request import HTTPRedirectHandler, build_opener, urlopen
from urllib.request import Request as UrlRequest

import httpx
from fastapi import FastAPI, HTTPException, Query, Request, status
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel, Field

DATA_DIR = Path(os.getenv("DATA_DIR", "/data/jobs"))
MAX_UPLOAD_BYTES = int(float(os.getenv("MAX_UPLOAD_GB", "12")) * 1024**3)
MIN_FREE_BYTES = int(float(os.getenv("MIN_FREE_GB", "5")) * 1024**3)
RETENTION_SECONDS = int(float(os.getenv("RETENTION_HOURS", "24")) * 3600)
MAX_CONCURRENT_JOBS = max(1, int(os.getenv("MAX_CONCURRENT_JOBS", "1")))
AUDIT_DIR = Path(os.getenv("AUDIT_DIR", str(DATA_DIR.parent / "audit")))
BRAVE_SEARCH_API_KEY = os.getenv("BRAVE_SEARCH_API_KEY", "").strip()
RESEARCH_RATE_LIMIT = max(1, int(os.getenv("RESEARCH_RATE_LIMIT", "30")))
WHISPER_URL = os.getenv("WHISPER_URL", "http://transcriber:8080").rstrip("/")
MAX_TRANSCRIPTION_SECONDS = int(
    float(os.getenv("MAX_TRANSCRIPTION_HOURS", "6")) * 3600
)

ALLOWED_EXTENSIONS = {"mp4", "mov", "avi", "mkv", "webm", "m4v", "mpeg", "mpg"}
ALLOWED_AUDIO_EXTENSIONS = {
    "mp3",
    "wav",
    "m4a",
    "aac",
    "ogg",
    "flac",
    "opus",
    "wma",
    "webm",
}
ALLOWED_TRANSCRIPTION_EXTENSIONS = ALLOWED_AUDIO_EXTENSIONS | ALLOWED_EXTENSIONS
ALLOWED_TRANSCRIPTION_LANGUAGES = {"auto", "pt", "en", "es"}
ALLOWED_BITRATES = {128, 192, 256, 320}
FORMAT_CONFIG = {
    "mp3": {"args": ["-c:a", "libmp3lame"], "mime": "audio/mpeg"},
    "wav": {"args": ["-c:a", "pcm_s16le"], "mime": "audio/wav"},
    "m4a": {"args": ["-c:a", "aac", "-movflags", "+faststart"], "mime": "audio/mp4"},
    "ogg": {"args": ["-c:a", "libvorbis"], "mime": "audio/ogg"},
}

jobs: dict[str, dict[str, Any]] = {}
processing_slots = asyncio.Semaphore(MAX_CONCURRENT_JOBS)
background_tasks: set[asyncio.Task[Any]] = set()
research_requests: dict[str, list[int]] = {}

ALLOWED_RESEARCH_PURPOSES = {
    "Qualificação de lead B2B recebido",
    "Preparação de atendimento solicitado",
    "Atualização cadastral de cliente",
    "Prevenção de duplicidade no CRM",
}
PERSONAL_EMAIL_DOMAINS = {
    "gmail.com",
    "hotmail.com",
    "outlook.com",
    "live.com",
    "icloud.com",
    "yahoo.com",
    "yahoo.com.br",
    "bol.com.br",
    "uol.com.br",
    "proton.me",
    "protonmail.com",
}
BLOCKED_RESULT_DOMAINS = {
    "spokeo.com",
    "truepeoplesearch.com",
    "beenverified.com",
    "peoplefinder.com",
    "escavador.com",
}


class LeadResearchRequest(BaseModel):
    query: str = Field(min_length=3, max_length=200)
    query_type: Literal["lead", "cnpj", "domain", "company"]
    purpose: str = Field(min_length=5, max_length=120)
    justification: str = Field(min_length=10, max_length=300)
    authorized: bool


class WebsiteParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.title = ""
        self.description = ""
        self.links: list[str] = []
        self._in_title = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attributes = {key.lower(): value or "" for key, value in attrs}
        if tag.lower() == "title":
            self._in_title = True
        if tag.lower() == "meta":
            name = (attributes.get("name") or attributes.get("property") or "").lower()
            if name in {"description", "og:description"} and not self.description:
                self.description = attributes.get("content", "").strip()
        if tag.lower() == "a" and attributes.get("href"):
            self.links.append(attributes["href"].strip())

    def handle_endtag(self, tag: str) -> None:
        if tag.lower() == "title":
            self._in_title = False

    def handle_data(self, data: str) -> None:
        if self._in_title:
            self.title += data


def ensure_public_hostname(hostname: str) -> None:
    normalized = hostname.lower().rstrip(".")
    if not normalized or normalized == "localhost" or "." not in normalized:
        raise ValueError("O domínio informado não é público.")
    try:
        addresses = socket.getaddrinfo(normalized, 443, type=socket.SOCK_STREAM)
    except socket.gaierror as error:
        raise ValueError("O domínio não pôde ser encontrado.") from error
    if not addresses:
        raise ValueError("O domínio não pôde ser encontrado.")
    for address in addresses:
        ip = ipaddress.ip_address(address[4][0])
        if not ip.is_global:
            raise ValueError(
                "Endereços internos ou reservados não podem ser consultados."
            )


class SafeRedirectHandler(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # type: ignore[no-untyped-def]
        parsed = urlparse(newurl)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            raise HTTPError(newurl, code, "Redirecionamento não permitido", headers, fp)
        ensure_public_hostname(parsed.hostname)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def now() -> int:
    return int(time.time())


def safe_name(filename: str) -> str:
    cleaned = "".join(
        char for char in filename if char.isalnum() or char in " ._-()"
    ).strip()
    return cleaned[:180] or "video"


def clean_text(value: Any, limit: int = 500) -> str:
    if value is None:
        return ""
    return re.sub(r"\s+", " ", str(value)).strip()[:limit]


def format_cnpj(digits: str) -> str:
    return f"{digits[:2]}.{digits[2:5]}.{digits[5:8]}/{digits[8:12]}-{digits[12:]}"


def format_phone(value: Any) -> str:
    digits = re.sub(r"\D", "", str(value or ""))
    if len(digits) == 10:
        return f"({digits[:2]}) {digits[2:6]}-{digits[6:]}"
    if len(digits) == 11:
        return f"({digits[:2]}) {digits[2:7]}-{digits[7:]}"
    return ""


def valid_cnpj(digits: str) -> bool:
    if len(digits) != 14 or len(set(digits)) == 1:
        return False

    def check_digit(base: str, weights: list[int]) -> str:
        total = sum(int(number) * weight for number, weight in zip(base, weights))
        remainder = total % 11
        return "0" if remainder < 2 else str(11 - remainder)

    first = check_digit(digits[:12], [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2])
    second = check_digit(digits[:12] + first, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2])
    return digits[-2:] == first + second


def normalize_domain(raw_value: str) -> str:
    value = raw_value.strip().lower()
    if "@" in value:
        local, _, domain = value.rpartition("@")
        if not local or domain in PERSONAL_EMAIL_DOMAINS:
            raise ValueError(
                "E-mails pessoais não podem ser usados para enriquecimento."
            )
        value = domain
    if "://" not in value:
        value = f"https://{value}"
    parsed = urlparse(value)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ValueError("Informe um domínio empresarial válido.")
    hostname = parsed.hostname.encode("idna").decode("ascii").lower()
    if len(hostname) > 253 or not re.fullmatch(r"[a-z0-9.-]+", hostname):
        raise ValueError("Informe um domínio empresarial válido.")
    return hostname


def blocks_personal_lookup(value: str, query_type: str) -> bool:
    compact_digits = re.sub(r"\D", "", value)
    if query_type == "cnpj":
        return False
    if "@" in value or re.search(r"\bcpf\b", value, flags=re.IGNORECASE):
        return True
    return 10 <= len(compact_digits) <= 13


def detect_lead_query_type(value: str) -> str:
    """Classify a card value without treating a personal identifier as a search key."""
    digits = re.sub(r"\D", "", value)
    if len(digits) == 14 and valid_cnpj(digits):
        return "cnpj"
    candidate = value.strip().lower()
    if "@" in candidate:
        return "domain"
    if " " not in candidate and re.fullmatch(
        r"(?:https?://)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?:/[^\s]*)?", candidate
    ):
        return "domain"
    return "company"


def external_json(url: str, headers: dict[str, str] | None = None) -> dict[str, Any]:
    request_headers = {
        "Accept": "application/json",
        "User-Agent": "MediaTools-LeadIntel/1.0",
        **(headers or {}),
    }
    request = UrlRequest(url, headers=request_headers)
    with urlopen(request, timeout=12) as response:
        body = response.read(2 * 1024 * 1024 + 1)
        if len(body) > 2 * 1024 * 1024:
            raise ValueError("O provedor retornou uma resposta maior que o permitido.")
        return json.loads(body.decode("utf-8"))


def fetch_cnpj(cnpj_digits: str) -> tuple[dict[str, Any], str]:
    source_url = f"https://brasilapi.com.br/api/cnpj/v1/{cnpj_digits}"
    payload = external_json(source_url)
    street_type = clean_text(payload.get("descricao_tipo_de_logradouro"), 40)
    street = clean_text(payload.get("logradouro"), 120)
    number = clean_text(payload.get("numero"), 30)
    district = clean_text(payload.get("bairro"), 80)
    address = ", ".join(
        filter(None, [" ".join(filter(None, [street_type, street])), number, district])
    )
    secondary = [
        clean_text(item.get("descricao"), 120)
        for item in payload.get("cnaes_secundarios", [])[:8]
        if isinstance(item, dict) and item.get("descricao")
    ]
    partners = []
    for item in payload.get("qsa", [])[:20]:
        if not isinstance(item, dict) or not item.get("nome_socio"):
            continue
        partners.append(
            {
                "name": clean_text(item.get("nome_socio"), 180),
                "role": clean_text(item.get("qualificacao_socio"), 120),
                "joined_at": clean_text(item.get("data_entrada_sociedade"), 30),
                "entity_type": {
                    1: "Pessoa jurídica",
                    2: "Pessoa física",
                    3: "Estrangeiro",
                }.get(item.get("identificador_de_socio"), "Não informado"),
            }
        )
    company = {
        "legal_name": clean_text(payload.get("razao_social"), 180),
        "trade_name": clean_text(payload.get("nome_fantasia"), 180),
        "cnpj": format_cnpj(cnpj_digits),
        "registration_status": clean_text(
            payload.get("descricao_situacao_cadastral"), 80
        ),
        "opened_at": clean_text(payload.get("data_inicio_atividade"), 30),
        "size": clean_text(payload.get("descricao_porte") or payload.get("porte"), 80),
        "primary_activity": clean_text(payload.get("cnae_fiscal_descricao"), 180),
        "secondary_activities": secondary,
        "address": address,
        "city": clean_text(payload.get("municipio"), 100),
        "state": clean_text(payload.get("uf"), 2),
        "postal_code": clean_text(payload.get("cep"), 12),
        "legal_nature": clean_text(payload.get("natureza_juridica"), 120),
        "capital_social": payload.get("capital_social") or 0,
        "branch_type": clean_text(payload.get("descricao_identificador_matriz_filial"), 30),
        "business_email": clean_text(payload.get("email"), 180),
        "business_phone_1": format_phone(payload.get("ddd_telefone_1")),
        "business_phone_2": format_phone(payload.get("ddd_telefone_2")),
        "partners": partners,
    }
    return {key: value for key, value in company.items() if value}, source_url


def fetch_website(domain: str) -> dict[str, Any]:
    ensure_public_hostname(domain)
    url = f"https://{domain}/"
    opener = build_opener(SafeRedirectHandler())
    request = UrlRequest(
        url,
        headers={
            "Accept": "text/html,application/xhtml+xml",
            "User-Agent": "Mozilla/5.0 (compatible; MediaTools-LeadIntel/1.0)",
        },
    )
    with opener.open(request, timeout=10) as response:
        content_type = response.headers.get_content_type()
        if content_type not in {"text/html", "application/xhtml+xml"}:
            raise ValueError("O domínio não retornou uma página HTML.")
        body = response.read(768 * 1024 + 1)
        if len(body) > 768 * 1024:
            raise ValueError("A página é grande demais para a leitura segura.")
        final_url = response.geturl()
        encoding = response.headers.get_content_charset() or "utf-8"

    parser = WebsiteParser()
    parser.feed(body.decode(encoding, errors="replace"))
    social_domains = {
        "linkedin.com": "LinkedIn",
        "instagram.com": "Instagram",
        "facebook.com": "Facebook",
        "youtube.com": "YouTube",
        "youtu.be": "YouTube",
    }
    social_links: list[dict[str, str]] = []
    seen: set[str] = set()
    for link in parser.links:
        absolute = urljoin(final_url, link)
        parsed = urlparse(absolute)
        host = (parsed.hostname or "").lower().removeprefix("www.")
        label = next(
            (
                name
                for social, name in social_domains.items()
                if host == social or host.endswith(f".{social}")
            ),
            "",
        )
        if not label or absolute in seen:
            continue
        if "linkedin.com" in host and "/in/" in parsed.path.lower():
            continue
        seen.add(absolute)
        social_links.append({"label": label, "url": absolute[:500]})
        if len(social_links) == 6:
            break
    return {
        "url": final_url[:500],
        "title": clean_text(parser.title, 180),
        "description": clean_text(parser.description, 400),
        "social_links": social_links,
    }


def brave_search(query: str) -> list[dict[str, str]]:
    from urllib.parse import urlencode

    url = "https://api.search.brave.com/res/v1/web/search?" + urlencode(
        {"q": query[:300], "count": 8, "country": "BR", "search_lang": "pt-br"}
    )
    payload = external_json(url, {"X-Subscription-Token": BRAVE_SEARCH_API_KEY})
    results: list[dict[str, str]] = []
    for item in (payload.get("web") or {}).get("results", []):
        item_url = clean_text(item.get("url"), 500)
        parsed = urlparse(item_url)
        domain = (parsed.hostname or "").lower().removeprefix("www.")
        if not item_url or not domain or domain in BLOCKED_RESULT_DOMAINS:
            continue
        if domain.endswith("linkedin.com") and "/in/" in parsed.path.lower():
            continue
        results.append(
            {
                "title": clean_text(item.get("title"), 180),
                "url": item_url,
                "description": clean_text(item.get("description"), 350),
                "domain": domain,
            }
        )
        if len(results) == 6:
            break
    return results


def check_research_rate(client_key: str) -> None:
    current = now()
    window_start = current - 600
    recent = [
        timestamp
        for timestamp in research_requests.get(client_key, [])
        if timestamp >= window_start
    ]
    if len(recent) >= RESEARCH_RATE_LIMIT:
        raise HTTPException(
            429, "Limite temporário de pesquisas atingido. Aguarde alguns minutos."
        )
    recent.append(current)
    research_requests[client_key] = recent


def audit_research(record: dict[str, Any]) -> None:
    AUDIT_DIR.mkdir(parents=True, exist_ok=True)
    path = AUDIT_DIR / "lead-research.jsonl"
    with path.open("a", encoding="utf-8") as audit_file:
        audit_file.write(
            json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n"
        )


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


def public_transcription_job(job: dict[str, Any]) -> dict[str, Any]:
    payload = {
        "id": job["id"],
        "status": job["status"],
        "progress": job.get("progress", 0),
        "stage": job.get("stage", "queued"),
        "language": job["language"],
        "detected_language": job.get("detected_language"),
        "original_name": job["original_name"],
        "input_size": job.get("input_size", 0),
        "created_at": job["created_at"],
        "updated_at": job["updated_at"],
    }
    if job.get("error"):
        payload["error"] = job["error"]
    if job["status"] == "ready":
        output_path = Path(job["output_path"])
        payload.update(
            output_name=job["output_name"],
            output_size=job["output_size"],
            character_count=job.get("character_count", 0),
            text=output_path.read_text(encoding="utf-8") if output_path.exists() else "",
            download_url=f"/api/transcriptions/{job['id']}/download",
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
            if job["status"] in {"uploading", "queued", "converting", "transcribing"}:
                job["status"] = "error"
                action = "transcrição" if job.get("kind") == "transcription" else "conversão"
                job["error"] = f"A {action} foi interrompida por uma reinicialização do servidor."
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
        raise RuntimeError("Não foi possível ler a duração do arquivo de mídia.")
    return max(float(stdout.decode().strip()), 0.001)


async def convert_job(job_id: str) -> None:
    job = jobs[job_id]
    async with processing_slots:
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
                    "-threads",
                    "2",
                    "-i",
                    str(input_path),
                    "-vn",
                    "-sn",
                    "-dn",
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


async def transcribe_with_whisper(
    audio_path: Path, language: str
) -> tuple[str, str | None]:
    timeout = httpx.Timeout(4 * 3600, connect=15)
    async with httpx.AsyncClient(timeout=timeout) as client:
        with audio_path.open("rb") as audio_file:
            response = await client.post(
                f"{WHISPER_URL}/inference",
                files={"file": ("audio.wav", audio_file, "audio/wav")},
                data={
                    "response_format": "json",
                    "language": language,
                    "temperature": "0.0",
                    "temperature_inc": "0.2",
                },
            )
    response.raise_for_status()
    payload = response.json()
    text = str(payload.get("text") or "").replace("\x00", "").strip()[:5_000_000]
    detected_language = clean_text(
        payload.get("language") or payload.get("detected_language"), 20
    )
    if not text:
        raise RuntimeError("Nenhuma fala foi identificada nesse áudio.")
    return text, detected_language or None


async def transcribe_job(job_id: str) -> None:
    job = jobs[job_id]
    async with processing_slots:
        input_path = Path(job["input_path"])
        wav_path = input_path.parent / "prepared.wav"
        output_path = Path(job["output_path"])
        log_path = input_path.parent / "transcription.log"
        try:
            job.update(status="transcribing", stage="preparing", progress=8, updated_at=now())
            persist(job)
            duration = await probe_duration(input_path)
            if duration > MAX_TRANSCRIPTION_SECONDS:
                hours = MAX_TRANSCRIPTION_SECONDS / 3600
                raise RuntimeError(
                    f"A mídia ultrapassa o limite de {hours:g} horas por transcrição."
                )

            with log_path.open("wb") as log_file:
                process = await asyncio.create_subprocess_exec(
                    "ffmpeg",
                    "-y",
                    "-hide_banner",
                    "-nostdin",
                    "-threads",
                    "2",
                    "-i",
                    str(input_path),
                    "-vn",
                    "-sn",
                    "-dn",
                    "-ar",
                    "16000",
                    "-ac",
                    "1",
                    "-c:a",
                    "pcm_s16le",
                    str(wav_path),
                    stdout=asyncio.subprocess.DEVNULL,
                    stderr=log_file,
                )
                exit_code = await process.wait()
            if exit_code != 0 or not wav_path.exists() or wav_path.stat().st_size == 0:
                raise RuntimeError("Não foi possível extrair ou preparar o áudio desta mídia.")

            job.update(stage="recognizing", progress=38, updated_at=now())
            persist(job)
            text, detected_language = await transcribe_with_whisper(
                wav_path, job["language"]
            )
            output_path.write_text(text.strip() + "\n", encoding="utf-8")
            job.update(
                status="ready",
                stage="complete",
                progress=100,
                detected_language=detected_language,
                output_size=output_path.stat().st_size,
                character_count=len(text),
                updated_at=now(),
            )
            persist(job)
        except httpx.HTTPError as error:
            output_path.unlink(missing_ok=True)
            job.update(
                status="error",
                stage="error",
                progress=0,
                error="O serviço de transcrição está indisponível no momento.",
                updated_at=now(),
            )
            persist(job)
            log_path.write_text(str(error), encoding="utf-8")
        except Exception as error:  # noqa: BLE001
            output_path.unlink(missing_ok=True)
            job.update(
                status="error",
                stage="error",
                progress=0,
                error=str(error),
                updated_at=now(),
            )
            persist(job)
        finally:
            input_path.unlink(missing_ok=True)
            wav_path.unlink(missing_ok=True)


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
    title="Media Tools API", docs_url=None, redoc_url=None, lifespan=lifespan
)


@app.get("/api/health")
async def health() -> dict[str, Any]:
    disk = shutil.disk_usage(DATA_DIR)
    return {
        "status": "ok",
        "free_bytes": disk.free,
        "active_jobs": sum(
            job["status"] in {"uploading", "queued", "converting", "transcribing"}
            for job in jobs.values()
        ),
        "max_upload_bytes": MAX_UPLOAD_BYTES,
        "lead_intel": {
            "status": "ok",
            "cnpj_provider": "available",
            "web_search": "available" if BRAVE_SEARCH_API_KEY else "unconfigured",
        },
        "transcription": {
            "status": "ok",
            "engine": "whisper.cpp",
            "max_duration_seconds": MAX_TRANSCRIPTION_SECONDS,
        },
    }


@app.post("/api/leads/research")
async def research_lead(
    payload: LeadResearchRequest, request: Request
) -> dict[str, Any]:
    if not payload.authorized:
        raise HTTPException(
            400, "Confirme a finalidade profissional legítima da pesquisa."
        )
    if payload.purpose not in ALLOWED_RESEARCH_PURPOSES:
        raise HTTPException(400, "Finalidade de pesquisa não permitida.")

    query = clean_text(payload.query, 200)
    effective_type = (
        detect_lead_query_type(query) if payload.query_type == "lead" else payload.query_type
    )
    if blocks_personal_lookup(query, effective_type):
        raise HTTPException(
            400,
            "Para proteger o titular, esta versão aceita somente identificadores empresariais: e-mail pessoal, telefone isolado e CPF não são permitidos. Use nome + empresa/cidade, CNPJ ou domínio corporativo.",
        )

    client_address = request.client.host if request.client else "unknown"
    client_key = hashlib.sha256(client_address.encode()).hexdigest()[:20]
    check_research_rate(client_key)

    research_id = uuid.uuid4().hex
    searched_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    company: dict[str, Any] | None = None
    website: dict[str, Any] | None = None
    web_results: list[dict[str, str]] = []
    sources: list[dict[str, str]] = []
    providers: list[dict[str, str]] = []
    warnings = [
        "Confirme os dados na fonte antes de atualizar o CRM.",
        "O resultado deve ser usado somente para a finalidade profissional declarada.",
    ]
    search_terms = query

    if effective_type == "cnpj":
        cnpj_digits = re.sub(r"\D", "", query)
        if not valid_cnpj(cnpj_digits):
            raise HTTPException(400, "Informe um CNPJ válido com 14 dígitos.")
        try:
            company, source_url = await asyncio.to_thread(fetch_cnpj, cnpj_digits)
            providers.append(
                {
                    "name": "BrasilAPI / Minha Receita",
                    "status": "ok",
                    "detail": "Cadastro empresarial localizado.",
                }
            )
            sources.append(
                {
                    "title": "Cadastro público de CNPJ",
                    "url": source_url,
                    "provider": "BrasilAPI",
                    "checked_at": searched_at,
                }
            )
            search_terms = " ".join(
                filter(
                    None,
                    [
                        company.get("legal_name", ""),
                        company.get("trade_name", ""),
                        company.get("city", ""),
                        "site oficial",
                    ],
                )
            )
        except HTTPError as error:
            if error.code == 404:
                providers.append(
                    {
                        "name": "BrasilAPI / Minha Receita",
                        "status": "not_found",
                        "detail": "CNPJ não localizado no provedor.",
                    }
                )
                warnings.append(
                    "O CNPJ não foi localizado na fonte cadastral consultada."
                )
            else:
                providers.append(
                    {
                        "name": "BrasilAPI / Minha Receita",
                        "status": "error",
                        "detail": "Provedor indisponível no momento.",
                    }
                )
                warnings.append(
                    "A consulta cadastral ficou indisponível; tente novamente mais tarde."
                )
        except (URLError, TimeoutError, ValueError, json.JSONDecodeError):
            providers.append(
                {
                    "name": "BrasilAPI / Minha Receita",
                    "status": "error",
                    "detail": "Falha temporária ao consultar o cadastro.",
                }
            )
            warnings.append(
                "A consulta cadastral ficou indisponível; tente novamente mais tarde."
            )

    if effective_type == "domain":
        try:
            domain = normalize_domain(query)
            website = await asyncio.to_thread(fetch_website, domain)
            providers.append(
                {
                    "name": "Site informado",
                    "status": "ok",
                    "detail": "Página pública acessada com proteção contra endereços internos.",
                }
            )
            sources.append(
                {
                    "title": website.get("title") or domain,
                    "url": website["url"],
                    "provider": "Site oficial informado",
                    "checked_at": searched_at,
                }
            )
            search_terms = f'"{domain}" empresa'
        except ValueError as error:
            raise HTTPException(400, str(error)) from error
        except (HTTPError, URLError, TimeoutError, UnicodeError):
            providers.append(
                {
                    "name": "Site informado",
                    "status": "error",
                    "detail": "Não foi possível acessar a página pública.",
                }
            )
            warnings.append(
                "O domínio foi reconhecido, mas o site não respondeu à leitura segura."
            )

    if effective_type == "company":
        if len(re.findall(r"[A-Za-zÀ-ÿ]", query)) < 3:
            raise HTTPException(
                400, "Informe o nome empresarial e, se possível, a cidade."
            )
        search_terms = f'"{query}" empresa Brasil site oficial'

    if BRAVE_SEARCH_API_KEY:
        try:
            web_results = await asyncio.to_thread(brave_search, search_terms)
            providers.append(
                {
                    "name": "Brave Search API",
                    "status": "ok" if web_results else "not_found",
                    "detail": f"{len(web_results)} resultado(s) empresarial(is) selecionado(s)."
                    if web_results
                    else "Nenhum resultado público relevante foi encontrado.",
                }
            )
            for item in web_results:
                sources.append(
                    {
                        "title": item["title"] or item["domain"],
                        "url": item["url"],
                        "provider": "Brave Search",
                        "checked_at": searched_at,
                    }
                )
        except (HTTPError, URLError, TimeoutError, ValueError, json.JSONDecodeError):
            providers.append(
                {
                    "name": "Brave Search API",
                    "status": "error",
                    "detail": "Pesquisa web indisponível no momento.",
                }
            )
            warnings.append(
                "A pesquisa web não respondeu. Os demais dados continuam válidos."
            )
    else:
        providers.append(
            {
                "name": "Pesquisa web",
                "status": "unconfigured",
                "detail": "Configure BRAVE_SEARCH_API_KEY no servidor para pesquisar por nome.",
            }
        )
        if effective_type == "company":
            warnings.append(
                "A pesquisa por nome precisa da chave do provedor web configurada na VPS."
            )

    audit_research(
        {
            "research_id": research_id,
            "searched_at": searched_at,
            "client_hash": client_key,
            "query_type": payload.query_type,
            "detected_type": effective_type,
            "query_fingerprint": hashlib.sha256(query.casefold().encode()).hexdigest(),
            "purpose": payload.purpose,
            "justification_fingerprint": hashlib.sha256(
                payload.justification.strip().encode()
            ).hexdigest(),
            "providers": [
                {"name": item["name"], "status": item["status"]} for item in providers
            ],
            "source_count": len(sources),
        }
    )

    return {
        "research_id": research_id,
        "searched_at": searched_at,
        "query_type": payload.query_type,
        "detected_type": effective_type,
        "company": company,
        "website": website,
        "web_results": web_results,
        "sources": sources,
        "providers": providers,
        "warnings": warnings,
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
        "kind": "conversion",
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
    if not job or job.get("kind", "conversion") != "conversion":
        raise HTTPException(404, "Conversão não encontrada ou já removida.")
    return public_job(job)


@app.get("/api/jobs/{job_id}/download")
async def download(job_id: str) -> FileResponse:
    job = jobs.get(job_id)
    if not job or job.get("kind", "conversion") != "conversion" or job["status"] != "ready":
        raise HTTPException(404, "O áudio ainda não está disponível.")
    output_path = Path(job["output_path"])
    if not output_path.exists():
        raise HTTPException(404, "O arquivo já foi removido.")
    return FileResponse(
        output_path,
        filename=job["output_name"],
        media_type=FORMAT_CONFIG[job["format"]]["mime"],
    )


@app.post("/api/transcriptions", status_code=status.HTTP_202_ACCEPTED)
async def create_transcription(
    request: Request,
    language: str = Query(default="auto"),
) -> dict[str, Any]:
    language = language.lower()
    if language not in ALLOWED_TRANSCRIPTION_LANGUAGES:
        raise HTTPException(400, "Idioma de transcrição inválido.")

    raw_name = unquote(request.headers.get("x-filename", "audio.mp3"))
    original_name = safe_name(raw_name)
    extension = original_name.rsplit(".", 1)[-1].lower() if "." in original_name else ""
    if extension not in ALLOWED_TRANSCRIPTION_EXTENSIONS:
        raise HTTPException(400, "Formato de áudio ou vídeo não permitido.")

    content_length = request.headers.get("content-length")
    expected_size = int(content_length) if content_length and content_length.isdigit() else 0
    if expected_size > MAX_UPLOAD_BYTES:
        raise HTTPException(413, "O arquivo ultrapassa o limite configurado no servidor.")
    transcription_work_bytes = MAX_TRANSCRIPTION_SECONDS * 32_000
    if shutil.disk_usage(DATA_DIR).free < expected_size + transcription_work_bytes + MIN_FREE_BYTES:
        raise HTTPException(507, "Não há espaço suficiente na VPS para transcrever esta mídia.")

    job_id = uuid.uuid4().hex
    job_dir = DATA_DIR / job_id
    job_dir.mkdir(parents=True)
    input_path = job_dir / f"input.{extension}"
    output_name = f"{safe_name(original_name.rsplit('.', 1)[0])}-transcricao.txt"
    output_path = job_dir / "transcription.txt"
    job: dict[str, Any] = {
        "id": job_id,
        "kind": "transcription",
        "status": "uploading",
        "stage": "uploading",
        "progress": 0,
        "language": language,
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
                    raise HTTPException(413, "O arquivo ultrapassa o limite configurado no servidor.")
                if received >= next_disk_check:
                    if shutil.disk_usage(DATA_DIR).free < MIN_FREE_BYTES + transcription_work_bytes:
                        raise HTTPException(507, "O disco da VPS atingiu o limite de segurança.")
                    next_disk_check += 64 * 1024**2
                destination.write(chunk)
        if received == 0:
            raise HTTPException(400, "O arquivo enviado está vazio.")
    except Exception:
        remove_job_files(job_id)
        raise

    job.update(status="queued", stage="queued", input_size=received, updated_at=now())
    persist(job)
    task = asyncio.create_task(transcribe_job(job_id))
    track(task)
    return public_transcription_job(job)


@app.get("/api/transcriptions/{job_id}")
async def get_transcription(job_id: str) -> dict[str, Any]:
    job = jobs.get(job_id)
    if not job or job.get("kind") != "transcription":
        raise HTTPException(404, "Transcrição não encontrada ou já removida.")
    return public_transcription_job(job)


@app.get("/api/transcriptions/{job_id}/download")
async def download_transcription(job_id: str) -> FileResponse:
    job = jobs.get(job_id)
    if not job or job.get("kind") != "transcription" or job["status"] != "ready":
        raise HTTPException(404, "A transcrição ainda não está disponível.")
    output_path = Path(job["output_path"])
    if not output_path.exists():
        raise HTTPException(404, "A transcrição já foi removida.")
    return FileResponse(
        output_path,
        filename=job["output_name"],
        media_type="text/plain; charset=utf-8",
    )


@app.delete(
    "/api/transcriptions/{job_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    response_class=Response,
)
async def delete_transcription(job_id: str) -> Response:
    job = jobs.get(job_id)
    if not job or job.get("kind") != "transcription":
        raise HTTPException(404, "Transcrição não encontrada.")
    if job["status"] in {"uploading", "queued", "transcribing"}:
        raise HTTPException(409, "A transcrição ainda está em andamento.")
    remove_job_files(job_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


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
