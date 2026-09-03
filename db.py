import sqlite3
import os

DB_PATH = os.path.join(os.path.dirname(__file__), "rss_reader.db")


def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db():
    conn = get_db()
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS feeds (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            url         TEXT    NOT NULL UNIQUE,
            title       TEXT,
            description TEXT,
            site_url    TEXT,
            added_at    TEXT    NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS articles (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            feed_id     INTEGER NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
            guid        TEXT    NOT NULL,
            title       TEXT,
            url         TEXT,
            author      TEXT,
            summary     TEXT,
            published   TEXT,
            is_read     INTEGER NOT NULL DEFAULT 0,
            is_starred  INTEGER NOT NULL DEFAULT 0,
            fetched_at  TEXT    NOT NULL DEFAULT (datetime('now')),
            UNIQUE(feed_id, guid)
        );

        CREATE TABLE IF NOT EXISTS tags (
            id   INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE
        );

        CREATE TABLE IF NOT EXISTS feed_tags (
            feed_id INTEGER NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
            tag_id  INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
            PRIMARY KEY (feed_id, tag_id)
        );
    """)
    conn.close()


def add_feed(url, title=None, description=None, site_url=None):
    conn = get_db()
    cursor = conn.execute(
        "INSERT INTO feeds (url, title, description, site_url) VALUES (?, ?, ?, ?)",
        (url, title, description, site_url),
    )
    feed_id = cursor.lastrowid
    conn.commit()
    conn.close()
    return feed_id


def get_feeds():
    conn = get_db()
    feeds = conn.execute("""
        SELECT f.*,
               COUNT(a.id) FILTER (WHERE a.is_read = 0) AS unread_count
        FROM feeds f
        LEFT JOIN articles a ON a.feed_id = f.id
        GROUP BY f.id
        ORDER BY f.title
    """).fetchall()
    result = []
    for f in feeds:
        d = dict(f)
        tags = conn.execute(
            """
            SELECT t.name FROM tags t
            JOIN feed_tags ft ON ft.tag_id = t.id
            WHERE ft.feed_id = ?
            ORDER BY t.name
        """,
            (d["id"],),
        ).fetchall()
        d["tags"] = [t["name"] for t in tags]
        result.append(d)
    conn.close()
    return result


def get_feed(feed_id):
    conn = get_db()
    feed = conn.execute("SELECT * FROM feeds WHERE id = ?", (feed_id,)).fetchone()
    conn.close()
    return dict(feed) if feed else None


def delete_feed(feed_id):
    conn = get_db()
    conn.execute("DELETE FROM feeds WHERE id = ?", (feed_id,))
    conn.commit()
    conn.close()


def add_articles(feed_id, articles):
    conn = get_db()
    inserted = 0
    for a in articles:
        cursor = conn.execute(
            """INSERT OR IGNORE INTO articles (feed_id, guid, title, url, author, summary, published)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (
                feed_id,
                a["guid"],
                a["title"],
                a["url"],
                a["author"],
                a["summary"],
                a["published"],
            ),
        )
        inserted += cursor.rowcount
    conn.commit()
    conn.close()
    return inserted


def get_articles(feed_id=None, is_read=None, is_starred=None, tag=None):
    conn = get_db()
    query = """
        SELECT a.*, f.title AS feed_title
        FROM articles a
        JOIN feeds f ON f.id = a.feed_id
    """
    params = []
    if tag is not None:
        query += " JOIN feed_tags ft ON ft.feed_id = f.id JOIN tags t ON t.id = ft.tag_id AND t.name = ?"
        params.append(tag)
    query += " WHERE 1=1"
    if feed_id is not None:
        query += " AND a.feed_id = ?"
        params.append(feed_id)
    if is_read is not None:
        query += " AND a.is_read = ?"
        params.append(is_read)
    if is_starred is not None:
        query += " AND a.is_starred = ?"
        params.append(is_starred)
    query += " ORDER BY a.is_read ASC, a.published DESC, a.fetched_at DESC"
    rows = conn.execute(query, params).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_articles_for_api(
    *,
    is_read=None,
    tags=None,
    published_after=None,
    published_before=None,
    fetched_after=None,
    fetched_before=None,
    limit=100,
):
    """Return a bounded article list for programmatic consumers.

    Multiple tags use OR semantics: an article is included when its feed has at
    least one requested tag.
    """
    conn = get_db()
    query = """
        SELECT a.*, f.title AS feed_title, f.url AS feed_url
        FROM articles a
        JOIN feeds f ON f.id = a.feed_id
        WHERE 1=1
    """
    params = []
    if is_read is not None:
        query += " AND a.is_read = ?"
        params.append(is_read)
    if tags:
        placeholders = ",".join("?" for _ in tags)
        query += f"""
            AND EXISTS (
                SELECT 1
                FROM feed_tags ft
                JOIN tags t ON t.id = ft.tag_id
                WHERE ft.feed_id = f.id AND t.name IN ({placeholders})
            )
        """
        params.extend(tags)
    for column, value, operator in (
        ("published", published_after, ">="),
        ("published", published_before, "<="),
        ("fetched_at", fetched_after, ">="),
        ("fetched_at", fetched_before, "<="),
    ):
        if value is not None:
            query += f" AND datetime(a.{column}) {operator} datetime(?)"
            params.append(value)
    query += " ORDER BY COALESCE(a.published, a.fetched_at) DESC, a.id DESC LIMIT ?"
    params.append(limit)
    rows = [dict(row) for row in conn.execute(query, params).fetchall()]

    feed_ids = sorted({row["feed_id"] for row in rows})
    tags_by_feed = {feed_id: [] for feed_id in feed_ids}
    if feed_ids:
        placeholders = ",".join("?" for _ in feed_ids)
        tag_rows = conn.execute(
            f"""
                SELECT ft.feed_id, t.name
                FROM feed_tags ft
                JOIN tags t ON t.id = ft.tag_id
                WHERE ft.feed_id IN ({placeholders})
                ORDER BY t.name
            """,
            feed_ids,
        ).fetchall()
        for tag_row in tag_rows:
            tags_by_feed[tag_row["feed_id"]].append(tag_row["name"])
    conn.close()

    for row in rows:
        row["tags"] = tags_by_feed[row["feed_id"]]
    return rows


def update_article(article_id, **kwargs):
    conn = get_db()
    for field in ("is_read", "is_starred"):
        if field in kwargs:
            conn.execute(
                f"UPDATE articles SET {field} = ? WHERE id = ?",
                (kwargs[field], article_id),
            )
    conn.commit()
    conn.close()


def mark_all_read(feed_id=None):
    conn = get_db()
    if feed_id is not None:
        conn.execute("UPDATE articles SET is_read = 1 WHERE feed_id = ?", (feed_id,))
    else:
        conn.execute("UPDATE articles SET is_read = 1")
    conn.commit()
    conn.close()


def get_tags():
    conn = get_db()
    tags = conn.execute("""
        SELECT t.name,
               COUNT(DISTINCT ft.feed_id) AS feed_count,
               COUNT(a.id) FILTER (WHERE a.is_read = 0) AS unread_count
        FROM tags t
        JOIN feed_tags ft ON ft.tag_id = t.id
        LEFT JOIN articles a ON a.feed_id = ft.feed_id
        GROUP BY t.id
        ORDER BY t.name
    """).fetchall()
    conn.close()
    return [dict(t) for t in tags]


def set_feed_tags(feed_id, tag_names):
    conn = get_db()
    conn.execute("DELETE FROM feed_tags WHERE feed_id = ?", (feed_id,))
    for name in tag_names:
        name = name.strip().lower()
        if not name:
            continue
        conn.execute("INSERT OR IGNORE INTO tags (name) VALUES (?)", (name,))
        tag_id = conn.execute("SELECT id FROM tags WHERE name = ?", (name,)).fetchone()[
            "id"
        ]
        conn.execute(
            "INSERT INTO feed_tags (feed_id, tag_id) VALUES (?, ?)", (feed_id, tag_id)
        )
    # Clean up orphaned tags
    conn.execute("DELETE FROM tags WHERE id NOT IN (SELECT tag_id FROM feed_tags)")
    conn.commit()
    conn.close()


def rename_tag(old_name, new_name):
    new_name = new_name.strip().lower()
    if not new_name:
        return
    conn = get_db()
    # If new name already exists, merge into it
    existing = conn.execute(
        "SELECT id FROM tags WHERE name = ?", (new_name,)
    ).fetchone()
    old = conn.execute("SELECT id FROM tags WHERE name = ?", (old_name,)).fetchone()
    if not old:
        conn.close()
        return
    if existing:
        # Move feed_tags from old to existing, ignoring dupes
        conn.execute(
            """
            INSERT OR IGNORE INTO feed_tags (feed_id, tag_id)
            SELECT feed_id, ? FROM feed_tags WHERE tag_id = ?
        """,
            (existing["id"], old["id"]),
        )
        conn.execute("DELETE FROM feed_tags WHERE tag_id = ?", (old["id"],))
        conn.execute("DELETE FROM tags WHERE id = ?", (old["id"],))
    else:
        conn.execute("UPDATE tags SET name = ? WHERE id = ?", (new_name, old["id"]))
    conn.commit()
    conn.close()
