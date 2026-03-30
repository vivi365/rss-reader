let currentFeedId = null; // null means "all"
let currentTag = null;
let currentStarred = false;
let feeds = [];
let tags = [];

// --- Feed colors ---

const FEED_COLORS = [
    "#5B8DEF", "#E67E5A", "#6BBF8A", "#D4699E", "#8B7EC8",
    "#E6A44E", "#4DBFBF", "#C75B5B", "#7EAA5B", "#B07EC8",
    "#5BA0C7", "#C7A05B",
];
const feedColorMap = {};

function getFeedColor(feedId) {
    if (!feedColorMap[feedId]) {
        const idx = Object.keys(feedColorMap).length % FEED_COLORS.length;
        feedColorMap[feedId] = FEED_COLORS[idx];
    }
    return feedColorMap[feedId];
}

// --- API helpers ---

async function api(method, path, body) {
    const opts = { method, headers: {} };
    if (body !== undefined) {
        opts.headers["Content-Type"] = "application/json";
        opts.body = JSON.stringify(body);
    }
    const res = await fetch(path, opts);
    if (res.status === 204) return null;
    if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Request failed (${res.status})`);
    }
    return res.json();
}

// --- Time formatting ---

function timeAgo(isoString) {
    if (!isoString) return "";
    const seconds = Math.floor((Date.now() - new Date(isoString).getTime()) / 1000);
    if (seconds < 60) return "just now";
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days}d ago`;
    return new Date(isoString).toLocaleDateString();
}

// --- Strip HTML tags from summary ---

function stripHtml(html) {
    const tmp = document.createElement("div");
    tmp.innerHTML = html;
    return tmp.textContent || tmp.innerText || "";
}

// --- Escape HTML ---

function escapeHtml(text) {
    if (!text) return "";
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
}

// --- Sidebar state helpers ---

function setFilter(feedId, tag, starred) {
    currentFeedId = feedId;
    currentTag = tag;
    currentStarred = starred;
    renderSidebar();
    loadArticles();
}

// --- Render sidebar ---

async function loadSidebar() {
    feeds = await api("GET", "/api/feeds");
    tags = await api("GET", "/api/tags");
    renderSidebar();
}

function renderSidebar() {
    const nav = document.querySelector(".feed-list");
    const totalUnread = feeds.reduce((sum, f) => sum + f.unread_count, 0);

    const isAll = !currentFeedId && !currentTag && !currentStarred;
    const isStarred = currentStarred;

    let html = `
        <a href="#" class="feed-item ${isAll ? "active" : ""}" data-filter="all">
            <span class="feed-name">All feeds</span>
            <span class="feed-count">${totalUnread || ""}</span>
        </a>
        <a href="#" class="feed-item ${isStarred ? "active" : ""}" data-filter="starred">
            <span class="feed-name">Starred</span>
        </a>
    `;

    // Tags section
    if (tags.length > 0) {
        html += '<div class="sidebar-section">Tags</div>';
        for (const tag of tags) {
            const active = currentTag === tag.name ? "active" : "";
            html += `
                <a href="#" class="feed-item tag-item ${active}" data-filter="tag" data-tag="${escapeHtml(tag.name)}">
                    <span class="feed-name"># ${escapeHtml(tag.name)}</span>
                    <span class="feed-count">${tag.unread_count || ""}</span>
                    <span class="feed-actions">
                        <button class="tag-rename-btn" data-tag="${escapeHtml(tag.name)}" title="Rename tag">&#9998;</button>
                    </span>
                </a>
            `;
        }
    }

    // Feeds section
    html += '<div class="sidebar-section">Feeds</div>';
    for (const feed of feeds) {
        const color = getFeedColor(feed.id);
        const active = currentFeedId === feed.id ? "active" : "";
        const tagStr = feed.tags.length ? feed.tags.map(t => `#${t}`).join(" ") : "";
        html += `
            <a href="#" class="feed-item ${active}" data-filter="feed" data-feed-id="${feed.id}">
                <span class="feed-dot" style="background: ${color}"></span>
                <span class="feed-name" title="${escapeHtml(feed.title || feed.url)}${tagStr ? " — " + tagStr : ""}">${escapeHtml(feed.title || feed.url)}</span>
                <span class="feed-count">${feed.unread_count || ""}</span>
                <span class="feed-actions">
                    <button class="feed-tag-btn" data-feed-id="${feed.id}" title="Edit tags">#</button>
                    <button class="feed-remove" data-feed-id="${feed.id}" title="Remove feed">&times;</button>
                </span>
            </a>
        `;
    }

    nav.innerHTML = html;

    // Click handlers
    nav.querySelectorAll(".feed-item").forEach((el) => {
        el.addEventListener("click", (e) => {
            if (e.target.classList.contains("feed-remove") || e.target.classList.contains("feed-tag-btn") || e.target.classList.contains("tag-rename-btn")) return;
            e.preventDefault();
            const filter = el.dataset.filter;
            if (filter === "all") setFilter(null, null, false);
            else if (filter === "starred") setFilter(null, null, true);
            else if (filter === "tag") setFilter(null, el.dataset.tag, false);
            else if (filter === "feed") setFilter(parseInt(el.dataset.feedId), null, false);
        });
    });

    // Tag rename
    nav.querySelectorAll(".tag-rename-btn").forEach((btn) => {
        btn.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            showTagRenamer(btn.dataset.tag);
        });
    });

    // Tag edit
    nav.querySelectorAll(".feed-tag-btn").forEach((btn) => {
        btn.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            const feedId = parseInt(btn.dataset.feedId);
            const feed = feeds.find(f => f.id === feedId);
            if (feed) showTagEditor(feedId, feed.tags);
        });
    });

    // Remove feed
    nav.querySelectorAll(".feed-remove").forEach((btn) => {
        btn.addEventListener("click", async (e) => {
            e.preventDefault();
            e.stopPropagation();
            const feedId = parseInt(btn.dataset.feedId);
            await api("DELETE", `/api/feeds/${feedId}`);
            if (currentFeedId === feedId) currentFeedId = null;
            await loadSidebar();
            await loadArticles();
        });
    });
}

// --- Render articles ---

async function loadArticles(restoreScrollTop) {
    const container = document.getElementById("articles-list");
    container.innerHTML = '<p class="loading">Loading...</p>';

    const params = new URLSearchParams();
    if (currentFeedId !== null) params.set("feed_id", currentFeedId);
    if (currentTag !== null) params.set("tag", currentTag);
    if (currentStarred) params.set("is_starred", 1);
    const qs = params.toString();
    const path = "/api/articles" + (qs ? `?${qs}` : "");

    const articles = await api("GET", path);

    if (articles.length === 0) {
        container.innerHTML = '<p class="empty-state">No articles yet.</p>';
        return;
    }

    container.innerHTML = articles.map((a) => {
        const color = getFeedColor(a.feed_id);
        return `
        <div class="article ${a.is_read ? "read" : ""}" data-id="${a.id}" style="--feed-color: ${color}">
            <div class="article-meta">
                <span class="article-feed-name" style="color: ${color}">${escapeHtml(a.feed_title)}</span>
                <span class="sep">/</span>
                <span>${timeAgo(a.published)}</span>
            </div>
            <div class="article-header">
                <div class="article-title">
                    <a href="${escapeHtml(a.url || "#")}" target="_blank" rel="noopener" data-article-id="${a.id}">${escapeHtml(a.title)}</a>
                </div>
                <button class="star-btn ${a.is_starred ? "starred" : ""}" data-id="${a.id}" data-starred="${a.is_starred}" title="${a.is_starred ? "Unstar" : "Star"}">&#9733;</button>
            </div>
            ${a.summary ? `<div class="article-summary">${escapeHtml(stripHtml(a.summary))}</div>` : ""}
            <div class="article-actions">
                <button class="toggle-read" data-id="${a.id}" data-read="${a.is_read}">${a.is_read ? "Mark unread" : "Mark read"}</button>
            </div>
        </div>
    `;
    }).join("");

    const scrollEl = document.querySelector(".content");

    // Article link click -> mark as read
    container.querySelectorAll(".article-title a").forEach((link) => {
        link.addEventListener("click", async () => {
            const id = parseInt(link.dataset.articleId);
            const scrollTop = scrollEl.scrollTop;
            await api("PATCH", `/api/articles/${id}`, { is_read: true });
            await loadSidebar();
            await loadArticles(scrollTop);
        });
    });

    // Star toggle
    container.querySelectorAll(".star-btn").forEach((btn) => {
        btn.addEventListener("click", async () => {
            const id = parseInt(btn.dataset.id);
            const starred = btn.dataset.starred === "1";
            const scrollTop = scrollEl.scrollTop;
            await api("PATCH", `/api/articles/${id}`, { is_starred: !starred });
            await loadArticles(scrollTop);
        });
    });

    // Toggle read/unread
    container.querySelectorAll(".toggle-read").forEach((btn) => {
        btn.addEventListener("click", async () => {
            const id = parseInt(btn.dataset.id);
            const isRead = btn.dataset.read === "1";
            const scrollTop = scrollEl.scrollTop;
            await api("PATCH", `/api/articles/${id}`, { is_read: !isRead });
            await loadSidebar();
            await loadArticles(scrollTop);
        });
    });

    if (restoreScrollTop !== undefined) {
        scrollEl.scrollTop = restoreScrollTop;
    }
}

// --- Tag renaming ---

function showTagRenamer(tagName) {
    const existing = document.querySelector(".tag-editor-overlay");
    if (existing) existing.remove();

    const overlay = document.createElement("div");
    overlay.className = "tag-editor-overlay";
    overlay.innerHTML = `
        <div class="tag-editor">
            <div class="tag-editor-title">Rename tag</div>
            <div class="tag-new-row">
                <input type="text" class="tag-editor-input" value="${escapeHtml(tagName)}" />
            </div>
            <div class="tag-editor-actions">
                <button class="tag-cancel">Cancel</button>
                <button class="tag-save">Rename</button>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);

    const input = overlay.querySelector(".tag-editor-input");
    input.focus();
    input.select();

    overlay.querySelector(".tag-cancel").addEventListener("click", () => overlay.remove());
    overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });

    async function save() {
        const newName = input.value.trim();
        if (!newName || newName === tagName) { overlay.remove(); return; }
        await api("PATCH", `/api/tags/${encodeURIComponent(tagName)}`, { name: newName });
        overlay.remove();
        if (currentTag === tagName) currentTag = newName.toLowerCase();
        await loadSidebar();
        await loadArticles();
    }

    overlay.querySelector(".tag-save").addEventListener("click", save);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") save(); });
}

// --- Tag editing ---

function showTagEditor(feedId, currentTags) {
    const existing = document.querySelector(".tag-editor-overlay");
    if (existing) existing.remove();

    // All known tags from sidebar
    const allTagNames = tags.map(t => t.name);
    // Selected tags for this feed
    let selected = new Set(currentTags.map(t => t.toLowerCase()));

    const overlay = document.createElement("div");
    overlay.className = "tag-editor-overlay";
    document.body.appendChild(overlay);

    function render() {
        // Merge all known + currently selected (in case some are new)
        const allNames = [...new Set([...allTagNames, ...selected])].sort();

        overlay.innerHTML = `
            <div class="tag-editor">
                <div class="tag-editor-title">Edit tags</div>
                ${allNames.length > 0 ? `
                    <div class="tag-toggles">
                        ${allNames.map(name => `
                            <button class="tag-toggle ${selected.has(name) ? "selected" : ""}" data-name="${escapeHtml(name)}"># ${escapeHtml(name)}</button>
                        `).join("")}
                    </div>
                ` : ""}
                <div class="tag-new-row">
                    <input type="text" class="tag-editor-input" placeholder="New tag..." />
                    <button class="tag-add-btn">Add</button>
                </div>
                <div class="tag-editor-actions">
                    <button class="tag-cancel">Cancel</button>
                    <button class="tag-save">Save</button>
                </div>
            </div>
        `;

        // Toggle existing tags
        overlay.querySelectorAll(".tag-toggle").forEach((btn) => {
            btn.addEventListener("click", () => {
                const name = btn.dataset.name;
                if (selected.has(name)) selected.delete(name);
                else selected.add(name);
                render();
            });
        });

        // Add new tag
        const input = overlay.querySelector(".tag-editor-input");
        const addBtn = overlay.querySelector(".tag-add-btn");

        function addNew() {
            const name = input.value.trim().toLowerCase();
            if (!name) return;
            selected.add(name);
            render();
        }

        addBtn.addEventListener("click", addNew);
        input.addEventListener("keydown", (e) => { if (e.key === "Enter") addNew(); });

        overlay.querySelector(".tag-cancel").addEventListener("click", () => overlay.remove());
        overlay.querySelector(".tag-save").addEventListener("click", async () => {
            await api("PUT", `/api/feeds/${feedId}/tags`, { tags: [...selected] });
            overlay.remove();
            await loadSidebar();
        });

        // Close on overlay click
        overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
    }

    render();
}

// --- Event listeners ---

document.getElementById("add-feed-btn").addEventListener("click", addFeed);
document.getElementById("feed-url-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") addFeed();
});

async function addFeed() {
    const input = document.getElementById("feed-url-input");
    const url = input.value.trim();
    if (!url) return;

    const btn = document.getElementById("add-feed-btn");
    btn.classList.add("loading-btn");
    btn.textContent = "...";

    try {
        await api("POST", "/api/feeds", { url });
        input.value = "";
        await loadSidebar();
        await loadArticles();
    } catch (err) {
        alert(err.message);
    } finally {
        btn.classList.remove("loading-btn");
        btn.textContent = "Add";
    }
}

document.getElementById("refresh-btn").addEventListener("click", async () => {
    const btn = document.getElementById("refresh-btn");
    btn.classList.add("loading-btn");
    btn.textContent = "Refreshing...";
    try {
        await api("POST", "/api/feeds/refresh");
        await loadSidebar();
        await loadArticles();
    } finally {
        btn.classList.remove("loading-btn");
        btn.textContent = "Refresh";
    }
});

document.getElementById("mark-all-read-btn").addEventListener("click", async () => {
    const body = currentFeedId !== null ? { feed_id: currentFeedId } : {};
    await api("POST", "/api/articles/mark-all-read", body);
    await loadSidebar();
    await loadArticles();
});

// Right-click on feed to edit tags
document.querySelector(".feed-list").addEventListener("contextmenu", (e) => {
    const feedItem = e.target.closest(".feed-item[data-feed-id]");
    if (!feedItem) return;
    e.preventDefault();
    const feedId = parseInt(feedItem.dataset.feedId);
    const feed = feeds.find(f => f.id === feedId);
    if (feed) showTagEditor(feedId, feed.tags);
});

// --- Init ---

loadSidebar();
loadArticles();
