/**
 * Service Worker for the offline FB2 reader.
 *
 * Книги хранятся в IndexedDB, поэтому SW кэширует только «оболочку»
 * приложения (полка, читалка, статические файлы). Работает и на
 * GitHub Pages в корне, и на странице проекта (под-путь): все пути
 * строятся относительно registration.scope.
 *
 * Strategies:
 *   - navigation  → network-first, оффлайн-фолбэк на кэшированную полку
 *   - same-origin static → cache-first, заполняем кэш по мере использования
 *   - кросс-ориджин (fonts.googleapis.com и т.п.) → не трогаем
 */

const CACHE_NAME = "fb2-offline-shell-v1";

const PRECACHE = [
    "index.html",
    "read.html",
    "reader.css",
    "reader.js",
    "book-db.js",
    "fb2.js",
    "shelf.js",
    "manifest.json",
    "favicon.svg",
    "offline.html",
];

self.addEventListener("install", (event) => {
    event.waitUntil(
        (async () => {
            const cache = await caches.open(CACHE_NAME);
            const scope = self.registration.scope;
            const base = new URL(scope, self.location);
            await Promise.all(
                PRECACHE.map(async (rel) => {
                    const url = new URL(rel, base);
                    try {
                        // request режим navigate для index.html/read.html, иначе статика
                        const req = new Request(url, {
                            credentials: "same-origin",
                            mode: rel.endsWith(".html") ? "navigate" : "cors",
                        });
                        const res = await fetch(req);
                        if (res.ok) await cache.put(url, res);
                    } catch (e) {
                        /* для offline.html нет смысла падать — но кэшируем что можем */
                    }
                }),
            );
            await self.skipWaiting();
        })(),
    );
});

self.addEventListener("activate", (event) => {
    event.waitUntil(
        (async () => {
            const keys = await caches.keys();
            await Promise.all(
                keys
                    .filter((k) => k !== CACHE_NAME)
                    .map((k) => caches.delete(k)),
            );
            await self.clients.claim();
        })(),
    );
});

self.addEventListener("fetch", (event) => {
    const req = event.request;
    if (req.method !== "GET") return;

    const url = new URL(req.url);
    if (url.origin !== self.location.origin) return;

    const scope = self.registration.scope;
    const isUnderScope = url.href.startsWith(scope);

    // Навигация (запрос HTML-страницы)
    if (req.mode === "navigate") {
        event.respondWith(
            (async () => {
                try {
                    const fresh = await fetch(req);
                    if (fresh.ok) {
                        const cache = await caches.open(CACHE_NAME);
                        cache.put(url, fresh.clone());
                    }
                    return fresh;
                } catch (e) {
                    const cache = await caches.open(CACHE_NAME);
                    // пытаемся отдать запрошенную страницу, иначе — полку
                    const hit =
                        (await cache.match(url)) ||
                        (await cache.match(new URL("index.html", scope))) ||
                        (await cache.match(new URL(scope, self.location))) ||
                        (await cache.match("offline.html"));
                    if (hit) return hit;
                    return new Response("Оффлайн: приложение ещё не открывалось онлайн.", {
                        status: 503,
                        headers: { "Content-Type": "text/plain; charset=utf-8" },
                    });
                }
            })(),
        );
        return;
    }

    // Статика и любые same-origin GET в пределах scope: cache-first + заполнение.
    // (Запросы с параметрами — это тоже навигации/чтение книги; оффлайн они
    // должны браться из кэша, куда их кладёт обработчик навигации выше.)
    if (isUnderScope) {
        event.respondWith(
            (async () => {
                const cache = await caches.open(CACHE_NAME);
                const cached = await cache.match(req, { ignoreSearch: true });
                if (cached) return cached;
                try {
                    const res = await fetch(req);
                    if (res.ok) cache.put(req, res.clone());
                    return res;
                } catch (e) {
                    return new Response("", { status: 404 });
                }
            })(),
        );
        return;
    }

    // Кросс-ориджин (шрифты Google и т.п.) — сеть, без кэша.
});