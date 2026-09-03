import calendar
import feedparser
from datetime import datetime, timezone
from urllib.parse import urlparse


def fetch_feed(url):
    scheme = urlparse(url).scheme
    if scheme not in ("http", "https"):
        raise ValueError(f"Only http/https URLs are supported, got: {scheme!r}")

    d = feedparser.parse(url)

    if d.bozo and not d.entries:
        raise ValueError(f"Failed to parse feed: {d.bozo_exception}")

    feed = d.feed
    result = {
        "title": getattr(feed, "title", url),
        "description": getattr(feed, "subtitle", None)
        or getattr(feed, "description", None),
        "site_url": getattr(feed, "link", None),
        "entries": [],
    }

    for entry in d.entries:
        guid = (
            getattr(entry, "id", None)
            or getattr(entry, "link", None)
            or entry.get("title", "")
        )
        published = None
        if hasattr(entry, "published_parsed") and entry.published_parsed:
            published = datetime.fromtimestamp(
                calendar.timegm(entry.published_parsed), tz=timezone.utc
            ).isoformat()
        elif hasattr(entry, "updated_parsed") and entry.updated_parsed:
            published = datetime.fromtimestamp(
                calendar.timegm(entry.updated_parsed), tz=timezone.utc
            ).isoformat()

        summary = getattr(entry, "summary", None) or ""
        # Truncate long summaries
        if len(summary) > 500:
            summary = summary[:500] + "..."

        result["entries"].append(
            {
                "guid": guid,
                "title": getattr(entry, "title", "Untitled"),
                "url": getattr(entry, "link", None),
                "author": getattr(entry, "author", None),
                "summary": summary,
                "published": published,
            }
        )

    return result
