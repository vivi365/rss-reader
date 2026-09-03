let currentView = "today";
let currentFeedId = null;
let currentTag = null;
let currentStarred = false;
let feeds = [];
let tags = [];
let currentArticles = [];
let selectedArticleId = null;

const FEED_COLORS = [
    "#7162a8", "#73a7a1", "#b47c6d", "#638ba1", "#8b829f",
    "#789d87", "#b18e62", "#718ba9", "#a4778f", "#688f8b",
];
const feedColorMap = {};

function getFeedColor(feedId) {
    if (!feedColorMap[feedId]) {
        const idx = Object.keys(feedColorMap).length % FEED_COLORS.length;
        feedColorMap[feedId] = FEED_COLORS[idx];
    }
    return feedColorMap[feedId];
}

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

function stripHtml(html) {
    const tmp = document.createElement("div");
    tmp.innerHTML = html;
    return tmp.textContent || tmp.innerText || "";
}

function escapeHtml(text) {
    if (!text) return "";
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
}

function escapeAttribute(text) {
    return String(text ?? "").replace(/[&<>"']/g, (character) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
    })[character]);
}

function dataFlag(value) {
    return value === "1" || value === "true";
}

function manageDialog(overlay, returnFocus) {
    function close() {
        overlay.remove();
        returnFocus?.focus();
    }

    overlay.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
            event.preventDefault();
            close();
            return;
        }
        if (event.key !== "Tab") return;
        const controls = [...overlay.querySelectorAll("button, input, a[href], [tabindex]:not([tabindex='-1'])")]
            .filter((element) => !element.disabled && element.offsetParent !== null);
        if (!controls.length) return;
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
        }
    });
    overlay.addEventListener("click", (event) => {
        if (event.target === overlay) close();
    });
    return close;
}

function safeUrl(url) {
    if (!url) return "#";
    try {
        const u = new URL(url);
        return (u.protocol === "http:" || u.protocol === "https:") ? url : "#";
    } catch {
        return "#";
    }
}

function setFilter(view, feedId = null, tag = null) {
    currentView = view;
    currentFeedId = feedId;
    currentTag = tag;
    currentStarred = view === "saved";
    selectedArticleId = null;
    renderSidebar();
    loadArticles();
}

async function loadSidebar() {
    feeds = await api("GET", "/api/feeds");
    tags = await api("GET", "/api/tags");
    renderSidebar();
}

function renderSidebar() {
    const nav = document.querySelector(".feed-list");
    const totalUnread = feeds.reduce((sum, f) => sum + f.unread_count, 0);
    const viewActive = (view) => currentView === view && currentFeedId === null && currentTag === null;

    let html = `
        <div class="feed-item ${viewActive("today") ? "active" : ""}"><button type="button" class="feed-select" data-filter="today">
            <span class="feed-name">Today</span><span class="feed-count">${Math.min(totalUnread, 4) || ""}</span>
        </button></div>
        <div class="feed-item ${viewActive("unread") ? "active" : ""}"><button type="button" class="feed-select" data-filter="unread">
            <span class="feed-name">Unread</span><span class="feed-count">${totalUnread || ""}</span>
        </button></div>
        <div class="feed-item ${viewActive("saved") ? "active" : ""}"><button type="button" class="feed-select" data-filter="saved">
            <span class="feed-name">Saved</span>
        </button></div>
        <div class="feed-item ${viewActive("all") ? "active" : ""}"><button type="button" class="feed-select" data-filter="all">
            <span class="feed-name">All feeds</span>
        </button></div>
    `;

    if (tags.length > 0) {
        html += '<div class="sidebar-section">Tags</div>';
        for (const tag of tags) {
            const active = currentTag === tag.name ? "active" : "";
            html += `
                <div class="feed-item tag-item ${active}">
                    <button type="button" class="feed-select" data-filter="tag" data-tag="${escapeAttribute(tag.name)}">
                        <span class="feed-name"># ${escapeHtml(tag.name)}</span>
                        <span class="feed-count">${tag.unread_count || ""}</span>
                    </button>
                    <span class="feed-actions">
                        <button type="button" class="tag-rename-btn" data-tag="${escapeAttribute(tag.name)}" title="Rename tag" aria-label="Rename ${escapeAttribute(tag.name)}">&#9998;</button>
                    </span>
                </div>
            `;
        }
    }

    html += '<div class="sidebar-section">Feeds</div>';
    for (const feed of feeds) {
        const color = getFeedColor(feed.id);
        const active = currentFeedId === feed.id ? "active" : "";
        const tagStr = feed.tags.length ? feed.tags.map(t => `#${t}`).join(" ") : "";
        html += `
            <div class="feed-item ${active}" data-feed-id="${feed.id}">
                <button type="button" class="feed-select" data-filter="feed" data-feed-id="${feed.id}">
                    <span class="feed-dot" style="background: ${color}" aria-hidden="true"></span>
                    <span class="feed-name" title="${escapeAttribute(`${feed.title || feed.url}${tagStr ? ` — ${tagStr}` : ""}`)}">${escapeHtml(feed.title || feed.url)}</span>
                    <span class="feed-count">${feed.unread_count || ""}</span>
                </button>
                <span class="feed-actions">
                    <button type="button" class="feed-tag-btn" data-feed-id="${feed.id}" title="Edit tags" aria-label="Edit tags for ${escapeAttribute(feed.title || feed.url)}">#</button>
                    <button type="button" class="feed-remove" data-feed-id="${feed.id}" title="Remove feed" aria-label="Remove ${escapeAttribute(feed.title || feed.url)}">&times;</button>
                </span>
            </div>
        `;
    }
    nav.innerHTML = html;

    nav.querySelectorAll(".feed-select").forEach((el) => {
        el.addEventListener("click", (e) => {
            const filter = el.dataset.filter;
            if (filter === "today" || filter === "unread" || filter === "saved" || filter === "all") {
                setFilter(filter);
            } else if (filter === "tag") {
                setFilter("tag", null, el.dataset.tag);
            } else if (filter === "feed") {
                setFilter("feed", parseInt(el.dataset.feedId, 10));
            }
        });
    });

    nav.querySelectorAll(".tag-rename-btn").forEach((btn) => {
        btn.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            showTagRenamer(btn.dataset.tag);
        });
    });
    nav.querySelectorAll(".feed-tag-btn").forEach((btn) => {
        btn.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            const feedId = parseInt(btn.dataset.feedId, 10);
            const feed = feeds.find(f => f.id === feedId);
            if (feed) showTagEditor(feedId, feed.tags);
        });
    });
    nav.querySelectorAll(".feed-remove").forEach((btn) => {
        btn.addEventListener("click", async (e) => {
            e.preventDefault();
            e.stopPropagation();
            const feedId = parseInt(btn.dataset.feedId, 10);
            await api("DELETE", `/api/feeds/${feedId}`);
            if (currentFeedId === feedId) {
                currentView = "today";
                currentFeedId = null;
                currentTag = null;
                currentStarred = false;
                selectedArticleId = null;
            }
            await loadSidebar();
            await loadArticles();
        });
    });
}

function viewCopy() {
    if (currentView === "today") return ["Reading queue", "Today", "The four most recent unread articles."];
    if (currentView === "unread") return ["Reading queue", "Unread", "Everything waiting for your attention."];
    if (currentView === "saved") return ["Reading queue", "Saved", "Articles you marked to return to."];
    if (currentView === "all") return ["Library", "All feeds", "The complete article archive."];
    if (currentView === "tag") return ["Collection", `# ${currentTag}`, "Articles from this tag."];
    const feed = feeds.find(f => f.id === currentFeedId);
    return ["Feed", feed?.title || "Feed", "Articles from this feed."];
}

function renderViewHeading() {
    const [kicker, title, description] = viewCopy();
    document.getElementById("section-kicker").textContent = kicker;
    document.getElementById("page-title").textContent = title;
    document.getElementById("page-description").textContent = description;
}

async function loadArticles(restoreScrollTop) {
    const container = document.getElementById("articles-list");
    container.innerHTML = '<p class="loading">Loading…</p>';
    renderViewHeading();

    const params = new URLSearchParams();
    if (currentFeedId !== null) params.set("feed_id", currentFeedId);
    if (currentTag !== null) params.set("tag", currentTag);
    if (currentView === "today" || currentView === "unread") params.set("is_read", 0);
    if (currentStarred) params.set("is_starred", 1);

    try {
        const qs = params.toString();
        const articles = await api("GET", "/api/articles" + (qs ? `?${qs}` : ""));
        currentArticles = currentView === "today" ? articles.slice(0, 4) : articles;
        const selectedStillExists = currentArticles.some(a => a.id === selectedArticleId);
        if (!selectedStillExists) selectedArticleId = currentArticles[0]?.id ?? null;
        renderArticleList();
        renderPreview();
        if (restoreScrollTop !== undefined) document.querySelector(".articles-pane").scrollTop = restoreScrollTop;
    } catch (err) {
        currentArticles = [];
        selectedArticleId = null;
        container.innerHTML = `<p class="empty-state">${escapeHtml(err.message)}</p>`;
        renderPreview();
    }
}

function renderArticleList() {
    const container = document.getElementById("articles-list");
    const count = document.getElementById("article-count");
    count.textContent = currentArticles.length ? `${currentArticles.length} article${currentArticles.length === 1 ? "" : "s"}` : "";
    if (currentArticles.length === 0) {
        container.innerHTML = `<p class="empty-state">${currentView === "today" || currentView === "unread" ? "Nothing unread." : "No articles yet."}</p>`;
        return;
    }

    container.innerHTML = currentArticles.map((a) => {
        const color = getFeedColor(a.feed_id);
        return `
        <article class="article ${a.is_read ? "read" : ""} ${a.id === selectedArticleId ? "selected" : ""}" data-id="${a.id}" tabindex="0" style="--feed-color: ${color}" aria-label="${escapeAttribute(a.title)}">
            <div class="article-meta">
                <span class="article-feed-name" style="color: ${color}">${escapeHtml(a.feed_title)}</span>
                <span class="sep" aria-hidden="true">/</span>
                <span>${timeAgo(a.published)}</span>
            </div>
            <div class="article-header">
                <div class="article-title">
                    <a href="${escapeAttribute(safeUrl(a.url))}" target="_blank" rel="noopener" data-article-id="${a.id}">${escapeHtml(a.title)}</a>
                </div>
                <button type="button" class="star-btn ${a.is_starred ? "starred" : ""}" data-id="${a.id}" data-starred="${a.is_starred}" title="${a.is_starred ? "Remove from saved" : "Save article"}" aria-label="${a.is_starred ? "Remove from saved" : "Save article"}">&#9733;</button>
            </div>
            ${a.summary ? `<div class="article-summary">${escapeHtml(stripHtml(a.summary))}</div>` : ""}
            <div class="article-actions">
                <button type="button" class="toggle-read" data-id="${a.id}" data-read="${a.is_read}">${a.is_read ? "Mark unread" : "Mark read"}</button>
            </div>
        </article>
    `;
    }).join("");

    const scrollEl = document.querySelector(".articles-pane");
    container.querySelectorAll(".article").forEach((article) => {
        article.addEventListener("click", (e) => {
            if (e.target.closest("a, button")) return;
            selectedArticleId = parseInt(article.dataset.id, 10);
            renderArticleList();
            renderPreview();
        });
        article.addEventListener("keydown", (e) => {
            if ((e.key === "Enter" || e.key === " ") && e.target === article) {
                e.preventDefault();
                selectedArticleId = parseInt(article.dataset.id, 10);
                renderArticleList();
                renderPreview();
            }
        });
    });
    container.querySelectorAll(".article-title a").forEach((link) => {
        link.addEventListener("click", async () => {
            const id = parseInt(link.dataset.articleId, 10);
            const scrollTop = scrollEl.scrollTop;
            await api("PATCH", `/api/articles/${id}`, { is_read: true });
            await loadSidebar();
            await loadArticles(scrollTop);
        });
    });
    container.querySelectorAll(".star-btn").forEach((btn) => {
        btn.addEventListener("click", async () => {
            const id = parseInt(btn.dataset.id, 10);
            const starred = dataFlag(btn.dataset.starred);
            const scrollTop = scrollEl.scrollTop;
            await api("PATCH", `/api/articles/${id}`, { is_starred: !starred });
            await loadSidebar();
            await loadArticles(scrollTop);
        });
    });
    container.querySelectorAll(".toggle-read").forEach((btn) => {
        btn.addEventListener("click", async () => {
            const id = parseInt(btn.dataset.id, 10);
            const isRead = dataFlag(btn.dataset.read);
            const scrollTop = scrollEl.scrollTop;
            await api("PATCH", `/api/articles/${id}`, { is_read: !isRead });
            await loadSidebar();
            await loadArticles(scrollTop);
        });
    });
}

function renderPreview() {
    const preview = document.getElementById("article-preview");
    const article = currentArticles.find(a => a.id === selectedArticleId);
    if (!article) {
        preview.innerHTML = '<div class="preview-placeholder"><span class="preview-rule" aria-hidden="true"></span><p>Select an article to read its summary.</p></div>';
        return;
    }
    const color = getFeedColor(article.feed_id);
    preview.innerHTML = `
        <div class="preview-content">
            <div class="article-meta">
                <span class="article-feed-name" style="color: ${color}">${escapeHtml(article.feed_title)}</span>
                <span class="sep" aria-hidden="true">/</span>
                <span>${timeAgo(article.published)}</span>
            </div>
            <h2>${escapeHtml(article.title)}</h2>
            <div class="preview-summary">${escapeHtml(stripHtml(article.summary || ""))}</div>
            <div class="preview-actions">
                <a href="${escapeAttribute(safeUrl(article.url))}" target="_blank" rel="noopener" class="open-article">Open article</a>
                <button type="button" class="preview-toggle-read">${article.is_read ? "Mark unread" : "Mark read"}</button>
                <button type="button" class="preview-toggle-star">${article.is_starred ? "Remove saved" : "Save"}</button>
            </div>
        </div>
    `;
    preview.querySelector(".open-article").addEventListener("click", async () => {
        if (article.is_read) return;
        await api("PATCH", `/api/articles/${article.id}`, { is_read: true });
        await loadSidebar();
        await loadArticles();
    });
    preview.querySelector(".preview-toggle-read").addEventListener("click", async () => {
        await api("PATCH", `/api/articles/${article.id}`, { is_read: !article.is_read });
        await loadSidebar();
        await loadArticles();
    });
    preview.querySelector(".preview-toggle-star").addEventListener("click", async () => {
        await api("PATCH", `/api/articles/${article.id}`, { is_starred: !article.is_starred });
        await loadSidebar();
        await loadArticles();
    });
}

function showTagRenamer(tagName) {
    const existing = document.querySelector(".tag-editor-overlay");
    if (existing) existing.remove();
    const returnFocus = document.activeElement;
    const overlay = document.createElement("div");
    overlay.className = "tag-editor-overlay";
    overlay.innerHTML = `
        <div class="tag-editor" role="dialog" aria-modal="true" aria-labelledby="tag-editor-title">
            <div class="tag-editor-title" id="tag-editor-title">Rename tag</div>
            <div class="tag-new-row"><label class="sr-only" for="tag-editor-input">Tag name</label><input type="text" class="tag-editor-input" id="tag-editor-input" value="${escapeAttribute(tagName)}" /></div>
            <div class="tag-editor-actions"><button type="button" class="tag-cancel">Cancel</button><button type="button" class="tag-save">Rename</button></div>
        </div>
    `;
    document.body.appendChild(overlay);
    const close = manageDialog(overlay, returnFocus);
    const input = overlay.querySelector(".tag-editor-input");
    input.focus();
    input.select();
    overlay.querySelector(".tag-cancel").addEventListener("click", close);
    async function save() {
        const newName = input.value.trim();
        if (!newName || newName === tagName) { close(); return; }
        await api("PATCH", `/api/tags/${encodeURIComponent(tagName)}`, { name: newName });
        close();
        if (currentTag === tagName) currentTag = newName.toLowerCase();
        await loadSidebar();
        await loadArticles();
    }
    overlay.querySelector(".tag-save").addEventListener("click", save);
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") save(); });
}

function showTagEditor(feedId, currentTags) {
    const existing = document.querySelector(".tag-editor-overlay");
    if (existing) existing.remove();
    const returnFocus = document.activeElement;
    const allTagNames = tags.map(t => t.name);
    let selected = new Set(currentTags.map(t => t.toLowerCase()));
    const overlay = document.createElement("div");
    overlay.className = "tag-editor-overlay";
    document.body.appendChild(overlay);
    const close = manageDialog(overlay, returnFocus);
    let firstRender = true;

    function render() {
        const allNames = [...new Set([...allTagNames, ...selected])].sort();
        overlay.innerHTML = `
            <div class="tag-editor" role="dialog" aria-modal="true" aria-labelledby="tag-editor-title">
                <div class="tag-editor-title" id="tag-editor-title">Edit tags</div>
                ${allNames.length > 0 ? `<div class="tag-toggles">${allNames.map(name => `<button type="button" class="tag-toggle ${selected.has(name) ? "selected" : ""}" data-name="${escapeAttribute(name)}"># ${escapeHtml(name)}</button>`).join("")}</div>` : ""}
                <div class="tag-new-row"><label class="sr-only" for="tag-editor-input">New tag</label><input type="text" class="tag-editor-input" id="tag-editor-input" placeholder="New tag…" /><button type="button" class="tag-add-btn">Add</button></div>
                <div class="tag-editor-actions"><button type="button" class="tag-cancel">Cancel</button><button type="button" class="tag-save">Save</button></div>
            </div>
        `;
        overlay.querySelectorAll(".tag-toggle").forEach((btn) => btn.addEventListener("click", () => {
            const name = btn.dataset.name;
            if (selected.has(name)) selected.delete(name); else selected.add(name);
            render();
        }));
        const input = overlay.querySelector(".tag-editor-input");
        function addNew() { const name = input.value.trim().toLowerCase(); if (!name) return; selected.add(name); render(); }
        overlay.querySelector(".tag-add-btn").addEventListener("click", addNew);
        input.addEventListener("keydown", (e) => { if (e.key === "Enter") addNew(); });
        overlay.querySelector(".tag-cancel").addEventListener("click", close);
        overlay.querySelector(".tag-save").addEventListener("click", async () => {
            await api("PUT", `/api/feeds/${feedId}/tags`, { tags: [...selected] });
            close();
            await loadSidebar();
        });
        if (firstRender) {
            input.focus();
            firstRender = false;
        }
    }
    render();
}

document.getElementById("add-feed-form").addEventListener("submit", (e) => { e.preventDefault(); addFeed(); });

async function addFeed() {
    const input = document.getElementById("feed-url-input");
    const url = input.value.trim();
    if (!url) return;
    const btn = document.getElementById("add-feed-btn");
    btn.classList.add("loading-btn");
    btn.textContent = "…";
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
    const status = document.getElementById("refresh-status");
    btn.classList.add("loading-btn");
    status.textContent = "Refreshing…";
    try {
        let refresh = await api("POST", "/api/v1/refreshes");
        while (refresh.status === "pending" || refresh.status === "running") {
            await new Promise(resolve => setTimeout(resolve, 500));
            refresh = await api("GET", `/api/v1/refreshes/${refresh.id}`);
        }
        await loadSidebar();
        await loadArticles();
        status.textContent = `${refresh.new_items} new · updated just now`;
        if (refresh.errors.length) alert(`${refresh.errors.length} feed(s) could not be refreshed.`);
    } catch (err) {
        status.textContent = "Refresh failed";
        alert(err.message);
    } finally {
        btn.classList.remove("loading-btn");
    }
});

document.getElementById("mark-all-read-btn").addEventListener("click", async () => {
    const message = currentFeedId !== null
        ? `Mark all articles in "${feeds.find((feed) => feed.id === currentFeedId)?.title || "this feed"}" as read?`
        : "Mark all articles as read?";
    if (!window.confirm(message)) return;
    const body = currentFeedId !== null ? { feed_id: currentFeedId } : {};
    await api("POST", "/api/articles/mark-all-read", body);
    await loadSidebar();
    await loadArticles();
});

document.querySelector(".feed-list").addEventListener("contextmenu", (e) => {
    const feedItem = e.target.closest(".feed-item[data-feed-id]");
    if (!feedItem) return;
    e.preventDefault();
    const feed = feeds.find(f => f.id === parseInt(feedItem.dataset.feedId, 10));
    if (feed) showTagEditor(feed.id, feed.tags);
});

loadSidebar();
loadArticles();
