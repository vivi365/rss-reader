from flask import Flask, render_template, request, jsonify
from db import (
    init_db, add_feed, get_feeds, delete_feed, add_articles,
    get_articles, update_article, mark_all_read, get_tags, set_feed_tags, rename_tag,
)
from feed_parser import fetch_feed

app = Flask(__name__)


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
    except Exception as e:
        return jsonify({"error": f"Could not fetch feed: {e}"}), 400

    try:
        feed_id = add_feed(url, parsed["title"], parsed["description"], parsed["site_url"])
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
    feeds = get_feeds()
    errors = []
    for feed in feeds:
        try:
            parsed = fetch_feed(feed["url"])
            add_articles(feed["id"], parsed["entries"])
        except Exception as e:
            errors.append({"feed_id": feed["id"], "error": str(e)})
    if errors:
        return jsonify({"refreshed": len(feeds) - len(errors), "errors": errors}), 207
    return jsonify({"refreshed": len(feeds)}), 200


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
    return jsonify(get_articles(feed_id=feed_id, is_read=is_read, is_starred=is_starred, tag=tag))


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
    app.run(debug=True, port=5000)
