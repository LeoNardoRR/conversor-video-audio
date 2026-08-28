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
        os.environ["AUDIT_DIR"] = str(Path(self.temporary_directory.name) / "audit")
        os.environ["MAX_UPLOAD_GB"] = "1"
        os.environ["MIN_FREE_GB"] = "0"
        os.environ.pop("BRAVE_SEARCH_API_KEY", None)
        from app import main

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

        with (
            patch.object(self.main, "convert_job", fake_conversion),
            TestClient(self.main.app) as client,
        ):
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

    def test_lead_research_requires_authorization_and_blocks_personal_lookup(
        self,
    ) -> None:
        base_payload = {
            "query": "Empresa Exemplo",
            "query_type": "company",
            "purpose": "Qualificação de lead B2B recebido",
            "justification": "Lead recebido pelo formulário comercial.",
            "authorized": False,
        }
        with TestClient(self.main.app) as client:
            denied = client.post("/api/leads/research", json=base_payload)
            self.assertEqual(denied.status_code, 400)

            personal = client.post(
                "/api/leads/research",
                json={**base_payload, "query": "11999998888", "authorized": True},
            )
            self.assertEqual(personal.status_code, 400)
            self.assertIn("identificadores empresariais", personal.json()["detail"])

    def test_cnpj_research_minimizes_data_and_audits_without_raw_query(self) -> None:
        company = {
            "legal_name": "EMPRESA TESTE LTDA",
            "trade_name": "EMPRESA TESTE",
            "cnpj": "19.131.243/0001-97",
            "registration_status": "ATIVA",
            "primary_activity": "Serviços de tecnologia",
            "city": "São Paulo",
            "state": "SP",
        }
        with (
            patch.object(
                self.main,
                "fetch_cnpj",
                return_value=(
                    company,
                    "https://brasilapi.com.br/api/cnpj/v1/19131243000197",
                ),
            ),
            TestClient(self.main.app) as client,
        ):
            response = client.post(
                "/api/leads/research",
                json={
                    "query": "19.131.243/0001-97",
                    "query_type": "cnpj",
                    "purpose": "Qualificação de lead B2B recebido",
                    "justification": "Lead recebido pelo formulário comercial.",
                    "authorized": True,
                },
            )

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["company"]["registration_status"], "ATIVA")
        self.assertEqual(payload["sources"][0]["provider"], "BrasilAPI")
        self.assertEqual(payload["providers"][-1]["status"], "unconfigured")

        audit_path = (
            Path(self.temporary_directory.name) / "audit" / "lead-research.jsonl"
        )
        audit_content = audit_path.read_text(encoding="utf-8")
        self.assertNotIn("19.131.243", audit_content)
        self.assertNotIn("Lead recebido", audit_content)
        self.assertIn(payload["research_id"], audit_content)

    def test_domain_research_uses_safe_public_website_result(self) -> None:
        website = {
            "url": "https://empresa.example/",
            "title": "Empresa Example",
            "description": "Soluções empresariais.",
            "social_links": [],
        }
        with (
            patch.object(self.main, "fetch_website", return_value=website),
            TestClient(self.main.app) as client,
        ):
            response = client.post(
                "/api/leads/research",
                json={
                    "query": "empresa.example",
                    "query_type": "domain",
                    "purpose": "Preparação de atendimento solicitado",
                    "justification": "Empresa solicitou uma demonstração comercial.",
                    "authorized": True,
                },
            )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["website"]["title"], "Empresa Example")

    def test_lead_input_auto_detects_cnpj(self) -> None:
        company = {
            "legal_name": "EMPRESA TESTE LTDA",
            "trade_name": "EMPRESA TESTE",
            "cnpj": "19.131.243/0001-97",
        }
        with (
            patch.object(
                self.main,
                "fetch_cnpj",
                return_value=(company, "https://brasilapi.com.br/api/cnpj/v1/19131243000197"),
            ),
            TestClient(self.main.app) as client,
        ):
            response = client.post(
                "/api/leads/research",
                json={
                    "query": "19.131.243/0001-97",
                    "query_type": "lead",
                    "purpose": "Qualificação de lead B2B recebido",
                    "justification": "Lead recebido pelo formulário comercial.",
                    "authorized": True,
                },
            )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["detected_type"], "cnpj")


if __name__ == "__main__":
    unittest.main()
