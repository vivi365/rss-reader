import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

import app as app_module
import db


class ApiTestCase(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.original_db_path = db.DB_PATH
        db.DB_PATH = str(Path(self.temp_dir.name) / "test.db")
        db.init_db()
        app_module.app.config.update(TESTING=True)
        self.client = app_module.app.test_client()
        with app_module._refresh_lock:
            app_module._refresh_runs.clear()
            app_module._active_refresh_id = None
            app_module._latest_refresh_id = None

    def tearDown(self):
        active = None
        with app_module._refresh_lock:
            if app_module._active_refresh_id:
                active = app_module._refresh_runs[app_module._active_refresh_id][
                    "_done"
                ]
        if active:
            active.wait(timeout=2)
        db.DB_PATH = self.original_db_path
        self.temp_dir.cleanup()

    def wait_for_run(self, run_id):
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            response = self.client.get(f"/api/v1/refreshes/{run_id}")
            body = response.get_json()
            if body["status"] in ("completed", "failed"):
                return body
            time.sleep(0.01)
        self.fail("refresh did not finish")

    def test_refresh_reports_new_items_and_per_feed_errors(self):
        feeds = [
            {"id": 1, "title": "Good", "url": "https://good.example/feed"},
            {"id": 2, "title": "Bad", "url": "https://bad.example/feed"},
        ]

        def fetch(url):
            if "bad" in url:
                raise ValueError("broken feed")
            return {"entries": [{"guid": "one"}]}

        with (
            patch.object(app_module, "get_feeds", return_value=feeds),
            patch.object(app_module, "fetch_feed", side_effect=fetch),
            patch.object(app_module, "add_articles", return_value=3),
        ):
            started = self.client.post("/api/v1/refreshes")
            self.assertEqual(started.status_code, 202)
            location = started.headers["Location"]
            result = self.wait_for_run(started.get_json()["id"])

        self.assertEqual(location, f"/api/v1/refreshes/{result['id']}")
        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["feeds_total"], 2)
        self.assertEqual(result["feeds_succeeded"], 1)
        self.assertEqual(result["new_items"], 3)
        self.assertEqual(result["errors"][0]["feed_id"], 2)
        self.assertEqual(result["errors"][0]["error"], "broken feed")

    def test_concurrent_refresh_reuses_active_run(self):
        entered = threading.Event()
        release = threading.Event()

        def blocking_fetch(_url):
            entered.set()
            self.assertTrue(release.wait(timeout=2))
            return {"entries": []}

        feeds = [{"id": 1, "title": "Feed", "url": "https://example.test/feed"}]
        with (
            patch.object(app_module, "get_feeds", return_value=feeds),
            patch.object(app_module, "fetch_feed", side_effect=blocking_fetch),
            patch.object(app_module, "add_articles", return_value=0),
        ):
            first = self.client.post("/api/v1/refreshes")
            self.assertTrue(entered.wait(timeout=1))
            second = self.client.post("/api/v1/refreshes")
            self.assertEqual(second.status_code, 202)
            self.assertEqual(second.get_json()["id"], first.get_json()["id"])
            self.assertTrue(second.get_json()["reused"])
            release.set()
            result = self.wait_for_run(first.get_json()["id"])

        self.assertEqual(result["status"], "completed")

    def test_run_level_failure_is_reported_by_latest_status(self):
        with patch.object(
            app_module, "get_feeds", side_effect=RuntimeError("database unavailable")
        ):
            started = self.client.post("/api/v1/refreshes")
            result = self.wait_for_run(started.get_json()["id"])

        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["errors"][0]["feed_id"], None)
        self.assertEqual(result["errors"][0]["error"], "database unavailable")

        latest = self.client.get("/api/v1/refreshes/latest")
        self.assertEqual(latest.status_code, 200)
        self.assertEqual(latest.get_json()["id"], result["id"])
        self.assertEqual(latest.get_json()["status"], "failed")

    def test_article_endpoint_filters_unread_dates_and_any_requested_tag(self):
        ai_feed = db.add_feed("https://ai.example/feed", "AI")
        security_feed = db.add_feed("https://security.example/feed", "Security")
        other_feed = db.add_feed("https://other.example/feed", "Other")
        db.set_feed_tags(ai_feed, ["ai"])
        db.set_feed_tags(security_feed, ["cybersecurity"])
        db.set_feed_tags(other_feed, ["other"])

        def article(guid, title, published):
            return {
                "guid": guid,
                "title": title,
                "url": f"https://example.test/{guid}",
                "author": None,
                "summary": "Summary",
                "published": published,
            }

        self.assertEqual(
            db.add_articles(
                ai_feed, [article("ai-new", "AI new", "2026-09-02T10:00:00+00:00")]
            ),
            1,
        )
        self.assertEqual(
            db.add_articles(
                ai_feed, [article("ai-new", "AI new", "2026-09-02T10:00:00+00:00")]
            ),
            0,
        )
        db.add_articles(
            security_feed,
            [article("sec-new", "Security new", "2026-09-03T10:00:00+00:00")],
        )
        db.add_articles(
            other_feed, [article("other", "Other", "2026-09-03T11:00:00+00:00")]
        )
        db.add_articles(
            ai_feed, [article("ai-old", "AI old", "2026-08-01T10:00:00+00:00")]
        )
        db.add_articles(
            ai_feed, [article("ai-read", "AI read", "2026-09-03T12:00:00+00:00")]
        )
        read_article = next(
            item for item in db.get_articles() if item["guid"] == "ai-read"
        )
        db.update_article(read_article["id"], is_read=1)

        response = self.client.get(
            "/api/v1/articles",
            query_string={
                "is_read": "false",
                "tags": "ai,cybersecurity",
                "published_after": "2026-09-01T00:00:00Z",
                "published_before": "2026-09-04T00:00:00Z",
                "limit": 2,
            },
        )

        self.assertEqual(response.status_code, 200)
        body = response.get_json()
        self.assertEqual(body["count"], 2)
        self.assertEqual(
            [item["title"] for item in body["articles"]], ["Security new", "AI new"]
        )
        self.assertEqual(body["articles"][0]["tags"], ["cybersecurity"])

    def test_article_endpoint_rejects_invalid_filters(self):
        invalid_read = self.client.get("/api/v1/articles?is_read=maybe")
        invalid_limit = self.client.get("/api/v1/articles?limit=501")
        non_numeric_limit = self.client.get("/api/v1/articles?limit=many")
        invalid_date = self.client.get("/api/v1/articles?fetched_after=yesterday")

        self.assertEqual(invalid_read.status_code, 400)
        self.assertEqual(invalid_limit.status_code, 400)
        self.assertEqual(non_numeric_limit.status_code, 400)
        self.assertEqual(invalid_date.status_code, 400)


if __name__ == "__main__":
    unittest.main()
