import asyncio
import importlib
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient


class ConverterApiTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        os.environ["DATA_DIR"] = self.temporary_directory.name
        os.environ["MAX_UPLOAD_GB"] = "1"
        os.environ["MIN_FREE_GB"] = "0"
        import app.main as main

        self.main = importlib.reload(main)

    def tearDown(self) -> None:
        self.temporary_directory.cleanup()

    def test_health_and_invalid_extension(self) -> None:
        with TestClient(self.main.app) as client:
            health = client.get("/api/health")
            self.assertEqual(health.status_code, 200)
            self.assertEqual(health.json()["status"], "ok")

            invalid = client.post(
                "/api/jobs?format=mp3&bitrate=192",
                content=b"not-a-video",
                headers={"X-Filename": "documento.txt"},
            )
            self.assertEqual(invalid.status_code, 400)

    def test_stream_upload_progress_and_download(self) -> None:
        async def fake_conversion(job_id: str) -> None:
            await asyncio.sleep(0)
            job = self.main.jobs[job_id]
            output_path = Path(job["output_path"])
            output_path.write_bytes(b"audio-result")
            Path(job["input_path"]).unlink(missing_ok=True)
            job.update(
                status="ready",
                progress=100,
                output_size=output_path.stat().st_size,
                updated_at=self.main.now(),
            )
            self.main.persist(job)

        with patch.object(self.main, "convert_job", fake_conversion):
            with TestClient(self.main.app) as client:
                created = client.post(
                    "/api/jobs?format=mp3&bitrate=192",
                    content=b"small-video-payload",
                    headers={
                        "X-Filename": "treinamento.mp4",
                        "Content-Type": "video/mp4",
                    },
                )
                self.assertEqual(created.status_code, 202)
                job_id = created.json()["id"]

                for _ in range(20):
                    job = client.get(f"/api/jobs/{job_id}")
                    if job.json()["status"] == "ready":
                        break
                    asyncio.run(asyncio.sleep(0.01))

                payload = job.json()
                self.assertEqual(payload["status"], "ready")
                self.assertEqual(payload["progress"], 100)
                self.assertEqual(payload["output_name"], "treinamento.mp3")

                download = client.get(payload["download_url"])
                self.assertEqual(download.status_code, 200)
                self.assertEqual(download.content, b"audio-result")


if __name__ == "__main__":
    unittest.main()
