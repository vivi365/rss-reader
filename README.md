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
- Local automation API for refreshing and fetching a bounded article selection

## Running

### Manual

```
uv run python app.py
```

Starts the server at http://127.0.0.1:5000. Ctrl+C to stop.

### Launch agent (macOS only — runs on login, restarts on crash)

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

The launch agent can run inside a macOS sandbox that limits filesystem access.
Create the local profile from the publishable template:

```sh
cp rss-reader.sb.example rss-reader.sb
sandbox-exec \
  -D "HOME_DIR=$HOME" \
  -D "APP_DIR=$PWD" \
  -f rss-reader.sb \
  uv run python app.py
```

`rss-reader.sb` is intentionally ignored because a local profile may contain
machine-specific paths. A launch agent must pass `HOME_DIR` and `APP_DIR` using
`sandbox-exec -D` before the `-f` argument.

## How it works

### Files

- `app.py` -- Flask app, all API routes
- `db.py` -- SQLite schema, connection helper, all CRUD functions
- `feed_parser.py` -- Fetches and normalizes RSS/Atom feeds using `feedparser`
- `templates/index.html` -- Single page HTML
- `static/style.css` -- Styles
- `static/app.js` -- All frontend logic
- `rss-reader.sb.example` -- parameterized macOS sandbox profile template
- `rss-reader.sb` -- ignored, machine-local sandbox profile
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

## Local automation API

The versioned JSON API is intended for scheduled jobs on the same machine. The
app still binds to Flask's loopback default (`127.0.0.1`); these endpoints do
not add authentication and should not be exposed to a network.

### Start or join a refresh

```sh
curl -i -X POST http://127.0.0.1:5000/api/v1/refreshes
```

The response is always `202 Accepted` and includes a `Location` header pointing
to the run. Only one refresh can be active. A concurrent request returns the
same run ID and sets `reused` to `true` instead of fetching every feed again.

```json
{
  "id": "56d9d7597cba4592a294bb81e07578b7",
  "status": "running",
  "created_at": "2026-09-03T08:00:00+00:00",
  "started_at": "2026-09-03T08:00:00+00:00",
  "completed_at": null,
  "feeds_total": 29,
  "feeds_succeeded": 4,
  "new_items": 7,
  "errors": [],
  "reused": false
}
```

Statuses are `pending`, `running`, `completed`, or `failed`. Individual feed
failures do not stop the run: the final status is `completed` and each failure
appears in `errors` with `feed_id`, `feed_title`, `url`, and `error`. `failed`
is reserved for a run-level failure, such as being unable to list feeds.

Refresh status is kept in process memory for the latest 50 completed runs. It
is intentionally not persisted across an app restart.

### Read refresh status

Poll the URL in the `Location` header until the run reaches `completed` or
`failed`:

```sh
curl http://127.0.0.1:5000/api/v1/refreshes/56d9d7597cba4592a294bb81e07578b7
```

The most recently started run is also available at:

```sh
curl http://127.0.0.1:5000/api/v1/refreshes/latest
```

Both status endpoints return `404` when the requested status is unavailable.

### Fetch a bounded article selection

```sh
curl -G http://127.0.0.1:5000/api/v1/articles \
  --data-urlencode 'is_read=false' \
  --data-urlencode 'tags=ai,cybersec' \
  --data-urlencode 'published_after=2026-08-28T00:00:00Z' \
  --data-urlencode 'limit=50'
```

The response has `articles`, `count`, and `limit`. Each article includes its
feed title, feed URL, and feed tags in addition to the stored article fields.
Results are newest first. Supported query parameters are:

| Parameter | Meaning |
|-----------|---------|
| `is_read` | `true`, `false`, `1`, or `0`; omit for both |
| `tag` / `tags` | Repeat or comma-separate feed tags; multiple tags use OR semantics |
| `published_after` | Inclusive ISO 8601 lower bound on publication time |
| `published_before` | Inclusive ISO 8601 upper bound on publication time |
| `fetched_after` | Inclusive ISO 8601 lower bound on local insertion time |
| `fetched_before` | Inclusive ISO 8601 upper bound on local insertion time |
| `limit` | Number of articles, default 100, minimum 1, maximum 500 |

Invalid booleans, timestamps, and limits return `400` with an `error` string.

For a scheduled reading digest, record the refresh response's `created_at`,
poll its `Location`, then query unread articles with `fetched_after` set to that
timestamp and `tags=ai,cybersec` (the current local tag names). Use
`published_after` instead when the
desired window is based on when posts were published rather than when this app
first saw them.
