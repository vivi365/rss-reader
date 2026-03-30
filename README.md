# RSS Reader

A lightweight, local RSS reader. Python/Flask backend, vanilla HTML/CSS/JS frontend, SQLite storage. Runs sandboxed as a macOS launch agent.

Open http://127.0.0.1:5000 in your browser.

## Features

- Add/remove RSS feeds
- Browse articles sorted with unread on top
- Mark articles as read/unread
- Star/favorite articles
- Tag feeds (a feed can have multiple tags, e.g. `ai`, `cybersecurity`)
- Filter by tag or starred in the sidebar
- Rename tags
- Refresh all feeds

## Running

### Manual

```
uv run python app.py
```

Starts the server at http://127.0.0.1:5000. Ctrl+C to stop.

### Launch agent (runs on login, restarts on crash)

Load:

```
launchctl load ~/Library/LaunchAgents/com.rss-reader.plist
```

Unload (stop and remove from startup):

```
launchctl unload ~/Library/LaunchAgents/com.rss-reader.plist
```

Check status:

```
launchctl list | grep rss-reader
```

View logs:

```
tail -f ~/code/rss-reader/rss-reader.log
```

## Sandbox

Runs inside a macOS sandbox (`rss-reader.sb`) — limits filesystem access to what the app actually needs.

## How it works

### Files

- `app.py` -- Flask app, all API routes
- `db.py` -- SQLite schema, connection helper, all CRUD functions
- `feed_parser.py` -- Fetches and normalizes RSS/Atom feeds using `feedparser`
- `templates/index.html` -- Single page HTML
- `static/style.css` -- Styles
- `static/app.js` -- All frontend logic
- `rss-reader.sb` -- macOS sandbox profile (plain text, Scheme-like syntax)
- `~/Library/LaunchAgents/com.rss-reader.plist` -- Launch agent config (plain text XML)

### Dependencies

Only two Python packages (pinned in `uv.lock`):

- `flask` -- web framework
- `feedparser` -- RSS/Atom parser

Dependencies do not auto-update. Run `uv lock --upgrade` manually if you want newer versions.

### Database

SQLite, stored at `rss_reader.db` in the project root. Tables:

- `feeds` -- feed URL, title, description
- `articles` -- title, URL, summary, read/starred status, linked to a feed
- `tags` -- tag names
- `feed_tags` -- many-to-many link between feeds and tags

### API

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/` | Serve the page |
| GET | `/api/feeds` | List feeds with unread counts and tags |
| POST | `/api/feeds` | Add a feed (body: `{"url": "..."}`) |
| DELETE | `/api/feeds/<id>` | Remove a feed and its articles |
| PUT | `/api/feeds/<id>/tags` | Set tags on a feed (body: `{"tags": ["ai", "security"]}`) |
| POST | `/api/feeds/refresh` | Re-fetch all feeds for new articles |
| GET | `/api/tags` | List all tags with unread counts |
| PATCH | `/api/tags/<name>` | Rename a tag (body: `{"name": "new-name"}`) |
| GET | `/api/articles` | List articles (query params: `feed_id`, `tag`, `is_read`, `is_starred`) |
| PATCH | `/api/articles/<id>` | Update article (body: `{"is_read": true}` or `{"is_starred": true}`) |
| POST | `/api/articles/mark-all-read` | Mark all (or filtered by feed_id) as read |

