import feedparser
from datetime import datetime
from time import mktime


def fetch_feed(url):
    d = feedparser.parse(url)

    if d.bozo and not d.entries:
        raise ValueError(f"Failed to parse feed: {d.bozo_exception}")

    feed = d.feed
    result = {
        "title": getattr(feed, "title", url),
        "description": getattr(feed, "subtitle", None) or getattr(feed, "description", None),
        "site_url": getattr(feed, "link", None),
        "entries": [],
    }

    for entry in d.entries:
        guid = getattr(entry, "id", None) or getattr(entry, "link", None) or entry.get("title", "")
        published = None
        if hasattr(entry, "published_parsed") and entry.published_parsed:
            published = datetime.fromtimestamp(mktime(entry.published_parsed)).isoformat()
        elif hasattr(entry, "updated_parsed") and entry.updated_parsed:
            published = datetime.fromtimestamp(mktime(entry.updated_parsed)).isoformat()

        summary = getattr(entry, "summary", None) or ""
        # Truncate long summaries
        if len(summary) > 500:
            summary = summary[:500] + "..."

        result["entries"].append({
            "guid": guid,
            "title": getattr(entry, "title", "Untitled"),
            "url": getattr(entry, "link", None),
            "author": getattr(entry, "author", None),
            "summary": summary,
            "published": published,
        })

    return result
