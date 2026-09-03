# RSS Reader

A small local RSS reader built with Flask, SQLite, and vanilla JavaScript.

## Run

```sh
uv run python app.py
```

Open <http://127.0.0.1:5000>. The database is created in the project directory
and is ignored by Git.

The reader supports feed tags, unread state, starred articles, and manual refresh.

## Local API

Scheduled jobs can refresh the feeds and fetch a short article list without
using the browser:

```text
POST /api/v1/refreshes
GET  /api/v1/refreshes/<id>
GET  /api/v1/refreshes/latest
GET  /api/v1/articles
```

Starting a refresh returns `202` and a `Location` header. Poll that URL until
the status is `completed` or `failed`, then fetch the articles you need:

```sh
curl -X POST http://127.0.0.1:5000/api/v1/refreshes

curl -G http://127.0.0.1:5000/api/v1/articles \
  --data-urlencode 'is_read=false' \
  --data-urlencode 'tags=ai,cybersec' \
  --data-urlencode 'fetched_after=2026-09-01T00:00:00Z' \
  --data-urlencode 'limit=50'
```

Article filters are `is_read`, `tag` or `tags`, `published_after`,
`published_before`, `fetched_after`, `fetched_before`, and `limit` (1–500).
Repeated tags use OR semantics. The API has no authentication and should remain
bound to localhost.

## Checks

```sh
uv run black --check .
uv run python -m unittest discover -s tests -v
```

## macOS sandbox

`rss-reader.sb.example` is a parameterized sandbox profile. To try it locally:

```sh
cp rss-reader.sb.example rss-reader.sb
sandbox-exec -D "HOME_DIR=$HOME" -D "APP_DIR=$PWD" \
  -f rss-reader.sb uv run python app.py
```

The machine-specific `rss-reader.sb` file is ignored by Git.
