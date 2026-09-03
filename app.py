from datetime import datetime, timezone
from threading import Event, Lock, Thread
from uuid import uuid4

from flask import Flask, render_template, request, jsonify, url_for
from db import (
    init_db,
    add_feed,
    get_feeds,
    delete_feed,
    add_articles,
    get_articles,
    get_articles_for_api,
    update_article,
    mark_all_read,
    get_tags,
    set_feed_tags,
    rename_tag,
)
from feed_parser import fetch_feed

app = Flask(__name__)

MAX_AUTOMATION_ARTICLES = 500
_refresh_lock = Lock()
_refresh_runs = {}
_active_refresh_id = None
_latest_refresh_id = None


def _utc_now():
    return datetime.now(timezone.utc).isoformat()


def _public_refresh(run, reused=False):
    result = {key: value for key, value in run.items() if key != "_done"}
    result["errors"] = [error.copy() for error in run["errors"]]
    result["reused"] = reused
    return result


def _perform_refresh(run_id):
    global _active_refresh_id
    with _refresh_lock:
        run = _refresh_runs[run_id]
        run["status"] = "running"
        run["started_at"] = _utc_now()

    try:
        feeds = get_feeds()
        with _refresh_lock:
            run["feeds_total"] = len(feeds)

        for feed in feeds:
            try:
                parsed = fetch_feed(feed["url"])
                inserted = add_articles(feed["id"], parsed["entries"])
                with _refresh_lock:
                    run["feeds_succeeded"] += 1
                    run["new_items"] += inserted
            except Exception as exc:
                with _refresh_lock:
                    run["errors"].append(
                        {
                            "feed_id": feed["id"],
                            "feed_title": feed.get("title"),
                            "url": feed["url"],
                            "error": str(exc),
                        }
                    )
    except Exception as exc:
        with _refresh_lock:
            run["status"] = "failed"
            run["errors"].append(
                {
                    "feed_id": None,
                    "feed_title": None,
                    "url": None,
                    "error": str(exc),
                }
            )
    finally:
        with _refresh_lock:
            if run["status"] != "failed":
                run["status"] = "completed"
            run["completed_at"] = _utc_now()
            _active_refresh_id = None
            run["_done"].set()


def _start_refresh():
    global _active_refresh_id, _latest_refresh_id
    with _refresh_lock:
        if _active_refresh_id is not None:
            return _refresh_runs[_active_refresh_id], True

        run_id = uuid4().hex
        run = {
            "id": run_id,
            "status": "pending",
            "created_at": _utc_now(),
            "started_at": None,
            "completed_at": None,
            "feeds_total": 0,
            "feeds_succeeded": 0,
            "new_items": 0,
            "errors": [],
            "_done": Event(),
        }
        _refresh_runs[run_id] = run
        _active_refresh_id = run_id
        _latest_refresh_id = run_id
        completed_ids = [
            existing_id
            for existing_id, existing in _refresh_runs.items()
            if existing_id != run_id and existing["status"] in ("completed", "failed")
        ]
        for existing_id in completed_ids[:-49]:
            del _refresh_runs[existing_id]

    Thread(target=_perform_refresh, args=(run_id,), daemon=True).start()
    return run, False


@app.before_request
def _init():
    init_db()
    app.before_request_funcs[None].remove(_init)


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/feeds", methods=["GET"])
def api_get_feeds():
    return jsonify(get_feeds())


@app.route("/api/feeds", methods=["POST"])
def api_add_feed():
    data = request.get_json()
    url = data.get("url", "").strip()
    if not url:
        return jsonify({"error": "URL is required"}), 400

    try:
        parsed = fetch_feed(url)
    except Exception:
        app.logger.warning("Could not fetch feed", exc_info=True)
        return jsonify({"error": "Could not fetch feed"}), 400

    try:
        feed_id = add_feed(
            url, parsed["title"], parsed["description"], parsed["site_url"]
        )
    except Exception:
        return jsonify({"error": "Feed already exists"}), 409

    add_articles(feed_id, parsed["entries"])

    tags = data.get("tags", [])
    if tags:
        set_feed_tags(feed_id, tags)

    return jsonify({"id": feed_id, "title": parsed["title"]}), 201


@app.route("/api/feeds/<int:feed_id>", methods=["DELETE"])
def api_delete_feed(feed_id):
    delete_feed(feed_id)
    return "", 204


@app.route("/api/feeds/<int:feed_id>/tags", methods=["PUT"])
def api_set_feed_tags(feed_id):
    data = request.get_json()
    tags = data.get("tags", [])
    set_feed_tags(feed_id, tags)
    return "", 204


@app.route("/api/feeds/refresh", methods=["POST"])
def api_refresh_feeds():
    # Backwards-compatible synchronous endpoint. It shares the coordinator, so
    # it cannot start a second refresh while the automation endpoint is active.
    run, _ = _start_refresh()
    run["_done"].wait()
    result = {
        "refreshed": run["feeds_succeeded"],
        "new_items": run["new_items"],
        "errors": run["errors"],
    }
    return jsonify(result), 207 if run["errors"] else 200


@app.route("/api/v1/refreshes", methods=["POST"])
def api_start_refresh():
    run, reused = _start_refresh()
    with _refresh_lock:
        response = jsonify(_public_refresh(run, reused=reused))
    response.status_code = 202
    response.headers["Location"] = url_for("api_get_refresh", run_id=run["id"])
    return response


@app.route("/api/v1/refreshes/<run_id>", methods=["GET"])
def api_get_refresh(run_id):
    with _refresh_lock:
        run = _refresh_runs.get(run_id)
        if run is None:
            return jsonify({"error": "Refresh run not found"}), 404
        return jsonify(_public_refresh(run))


@app.route("/api/v1/refreshes/latest", methods=["GET"])
def api_get_latest_refresh():
    with _refresh_lock:
        if _latest_refresh_id is None:
            return jsonify({"error": "No refresh has been started"}), 404
        return jsonify(_public_refresh(_refresh_runs[_latest_refresh_id]))


@app.route("/api/tags", methods=["GET"])
def api_get_tags():
    return jsonify(get_tags())


@app.route("/api/tags/<name>", methods=["PATCH"])
def api_rename_tag(name):
    data = request.get_json()
    new_name = data.get("name", "").strip()
    if not new_name:
        return jsonify({"error": "Name is required"}), 400
    rename_tag(name, new_name)
    return "", 204


@app.route("/api/articles", methods=["GET"])
def api_get_articles():
    feed_id = request.args.get("feed_id", type=int)
    is_read = request.args.get("is_read", type=int)
    is_starred = request.args.get("is_starred", type=int)
    tag = request.args.get("tag")
    return jsonify(
        get_articles(feed_id=feed_id, is_read=is_read, is_starred=is_starred, tag=tag)
    )


def _parse_boolean_arg(name):
    value = request.args.get(name)
    if value is None:
        return None
    normalized = value.strip().lower()
    if normalized in ("1", "true"):
        return 1
    if normalized in ("0", "false"):
        return 0
    raise ValueError(f"{name} must be one of: 0, 1, false, true")


def _parse_timestamp_arg(name):
    value = request.args.get(name)
    if value is None:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError(f"{name} must be an ISO 8601 timestamp") from exc
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc).isoformat()


@app.route("/api/v1/articles", methods=["GET"])
def api_get_articles_for_automation():
    try:
        is_read = _parse_boolean_arg("is_read")
        raw_limit = request.args.get("limit")
        try:
            limit = 100 if raw_limit is None else int(raw_limit)
        except ValueError as exc:
            raise ValueError(
                f"limit must be between 1 and {MAX_AUTOMATION_ARTICLES}"
            ) from exc
        if not 1 <= limit <= MAX_AUTOMATION_ARTICLES:
            raise ValueError(f"limit must be between 1 and {MAX_AUTOMATION_ARTICLES}")

        tags = []
        for value in request.args.getlist("tag") + request.args.getlist("tags"):
            tags.extend(
                part.strip().lower() for part in value.split(",") if part.strip()
            )

        articles = get_articles_for_api(
            is_read=is_read,
            tags=sorted(set(tags)),
            published_after=_parse_timestamp_arg("published_after"),
            published_before=_parse_timestamp_arg("published_before"),
            fetched_after=_parse_timestamp_arg("fetched_after"),
            fetched_before=_parse_timestamp_arg("fetched_before"),
            limit=limit,
        )
    except ValueError:
        return jsonify({"error": "Invalid query parameters"}), 400

    return jsonify({"articles": articles, "count": len(articles), "limit": limit})


@app.route("/api/articles/<int:article_id>", methods=["PATCH"])
def api_update_article(article_id):
    data = request.get_json()
    kwargs = {}
    if "is_read" in data:
        kwargs["is_read"] = 1 if data["is_read"] else 0
    if "is_starred" in data:
        kwargs["is_starred"] = 1 if data["is_starred"] else 0
    if kwargs:
        update_article(article_id, **kwargs)
    return "", 204


@app.route("/api/articles/mark-all-read", methods=["POST"])
def api_mark_all_read():
    data = request.get_json(silent=True) or {}
    feed_id = data.get("feed_id")
    mark_all_read(feed_id=feed_id)
    return "", 204


if __name__ == "__main__":
    app.run(debug=False, port=5000)
