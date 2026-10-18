/**
 * Service Worker for FB2 Reader.
 *
 * Strategies
 * ──────────
 *   /static/*              cache-first + background revalidation (If-None-Match / ETag)
 *   /book/{id}/read.html   cache-first + background revalidation (If-None-Match / ETag)
 *   /book/{id}/images/*    cache-first + background revalidation (If-None-Match / ETag)
 *   fonts.googleapis.com   cache-first forever (CSS with @font-face)
 *   fonts.gstatic.com      cache-first forever (.woff2, immutable)
 *   everything else        passthrough (SW does not interfere)
 *
 * Install:   precache reader.css + reader.js.
 * Activate:  clients.claim() to take control immediately.
 */

const STATIC_CACHE = "fb2-static-v1";
const BOOK_CACHE = "fb2-books-v1";
const IMAGE_CACHE = "fb2-images-v1";
const FONT_CACHE = "fb2-fonts-v1";

const PRECACHE_URLS = [
    "/",
    "/static/reader.css",
    "/static/reader.js",
    "/static/book-db.js",
    "/static/shelf.html",
    "/static/offline.html",
    "/static/favicon.svg",
    "/static/favicon-32.png",
    "/static/favicon-192.png",
    "/static/apple-touch-icon.png",
    "/favicon.ico",
];

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------
self.addEventListener("install", (event) => {
    event.waitUntil(
        caches
            .open(STATIC_CACHE)
            .then((cache) =>
                Promise.all(
                    PRECACHE_URLS.map((url) =>
                        fetch(url).then((res) => {
                            if (res.ok) {
                                return cache.put(url, res);
                            }
                            return null;
                        }),
                    ),
                ),
            )
            .then(() => self.skipWaiting()),
    );
});

// ---------------------------------------------------------------------------
// Activate
// ---------------------------------------------------------------------------
self.addEventListener("activate", (event) => {
    event.waitUntil(self.clients.claim());
});

// ---------------------------------------------------------------------------
// Messages from pages
// ---------------------------------------------------------------------------
self.addEventListener("message", (event) => {
    if (!event.data || event.data.type !== "CACHE_PAGE") {
        return;
    }
    const url = new URL(event.data.url, location.origin);
    if (url.origin !== location.origin || !isBookPagePath(url.pathname)) {
        return;
    }
    event.waitUntil(
        caches.open(BOOK_CACHE).then(async (cache) => {
            const existing = await cache.match(url.href, { ignoreVary: true });
            if (!existing) {
                const response = await fetch(url.href);
                if (response.ok) {
                    await cache.put(url.href, response);
                }
            }
        }),
    );
});

// ---------------------------------------------------------------------------
// Fetch
// ---------------------------------------------------------------------------
self.addEventListener("fetch", (event) => {
    const { request } = event;
    const url = new URL(request.url);

    if (request.method !== "GET") {
        return;
    }

    // ── Google Fonts: .woff2 files (immutable, cache forever) ──
    if (url.hostname === "fonts.gstatic.com") {
        event.respondWith(cacheFirst(request, FONT_CACHE));
        return;
    }

    // ── Google Fonts: CSS with @font-face (cache forever) ──
    if (url.hostname === "fonts.googleapis.com") {
        event.respondWith(cacheFirst(request, FONT_CACHE));
        return;
    }

    // Same-origin only below.
    if (url.origin !== location.origin) {
        return;
    }

    // ── Static assets ──
    if (url.pathname.startsWith("/static/")) {
        event.respondWith(cacheFirstRevalidate(event, request, STATIC_CACHE));
        return;
    }

    // ── Root (shelf) ──
    if (url.pathname === "/") {
        event.respondWith(
            cacheFirstRevalidate(
                event,
                request,
                STATIC_CACHE,
                "/static/offline.html",
            ),
        );
        return;
    }

    // ── Book HTML ──
    if (isBookPagePath(url.pathname)) {
        event.respondWith(
            cacheFirstRevalidate(
                event,
                request,
                BOOK_CACHE,
                "/static/offline.html",
            ),
        );
        return;
    }

    // ── Book images ──
    if (isBookImagePath(url.pathname)) {
        event.respondWith(cacheFirstRevalidate(event, request, IMAGE_CACHE));
        return;
    }

    // ── Offline navigation fallback ──
    if (request.mode === "navigate") {
        event.respondWith(
            fetch(request).catch(() => caches.match("/static/offline.html")),
        );
    }
});

function isBookPagePath(pathname) {
    const segments = getBookRouteSegments(pathname);
    if (!segments) {
        return false;
    }

    return segments.length === 4 && segments[3] === "read.html";
}

function isBookImagePath(pathname) {
    const segments = getBookRouteSegments(pathname);
    if (!segments) {
        return false;
    }

    return (
        segments.length >= 5 && segments[3] === "images" && segments[4] !== ""
    );
}

function getBookRouteSegments(pathname) {
    const segments = pathname.split("/");
    if (segments[1] !== "book") {
        return null;
    }
    if (!isPathInteger(segments[2])) {
        return null;
    }
    return segments;
}

function isPathInteger(value) {
    if (value === "") {
        return false;
    }

    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && String(parsed) === value;
}

// ---------------------------------------------------------------------------
// Strategies
// ---------------------------------------------------------------------------

/**
 * Cache-first, no revalidation. For immutable resources.
 */
async function cacheFirst(request, cacheName) {
    const cache = await caches.open(cacheName);
    const cached = await cache.match(request, { ignoreVary: true });
    if (cached) {
        return cached;
    }

    try {
        const response = await fetch(request);
        if (response.ok || response.type === "opaque") {
            await cache.put(request, response.clone());
        }
        return response;
    } catch {
        return new Response("Offline", { status: 503 });
    }
}

/**
 * One retry on TypeError to mask transient SW/network race conditions
 * (cold SW wakeup, idle-timeout kill mid-fetch, etc).
 */
async function fetchWithRetry(request) {
    try {
        return await fetch(request);
    } catch {
        await new Promise((r) => setTimeout(r, 200));
        return fetch(request);
    }
}

/**
 * Cache-first with background revalidation.
 *
 * - Cache hit:  return cached response immediately; revalidate in background
 *               using conditional headers (If-None-Match / If-Modified-Since)
 *               from the cached response. 304 = no update, 200 = cache updated
 *               (visible on next visit).
 *
 * - Cache miss: fetch from network, stream to client immediately,
 *               clone into cache via waitUntil (non-blocking).
 */
async function cacheFirstRevalidate(
    event,
    request,
    cacheName,
    offlineFallbackUrl = null,
) {
    const cache = await caches.open(cacheName);
    const cached = await cache.match(request, { ignoreVary: true });

    if (cached) {
        event.waitUntil(revalidate(request, cached, cache));
        return cached;
    }

    // Cache miss — fetch, stream to client, cache in background.
    try {
        const response = await fetchWithRetry(request);
        if (response.ok || response.type === "opaque") {
            event.waitUntil(cache.put(request, response.clone()));
        }
        return response;
    } catch {
        // Network failure (no internet). Show offline fallback if available.
        if (offlineFallbackUrl) {
            const fallback = await caches.match(offlineFallbackUrl);
            if (fallback) {
                return fallback;
            }
        }
        return new Response("Offline", { status: 503 });
    }
}

/**
 * Conditional revalidation using headers from a cached response.
 * Sends If-None-Match (ETag) and/or If-Modified-Since (Last-Modified).
 * On 200: updates cache. On 304 or error: does nothing.
 */
async function revalidate(request, cachedResponse, cache) {
    const headers = new Headers();
    const etag = cachedResponse.headers.get("ETag");
    const lastModified = cachedResponse.headers.get("Last-Modified");
    if (etag) {
        headers.set("If-None-Match", etag);
    }
    if (lastModified) {
        headers.set("If-Modified-Since", lastModified);
    }

    try {
        const response = await fetch(request, { headers });
        if (response.ok) {
            await cache.put(request, response);
        }
    } catch {
        // Offline — ignore, cached version is still valid.
    }
}
