/**
 * IndexedDB helper for the offline FB2 shelf & reader.
 *
 * Оффлайн-версия читалки fantasy-worlds.org: книги хранятся не на сервере,
 * а в браузере (импортированные из локальных .fb2 файлов).
 *
 * DB: "fb2-library", version 2
 * Stores:
 *   "books"    (keyPath: "book_id") — карточки книг для полки
 *   "progress" (keyPath: "book_id") — позиция чтения
 *   "content"  (keyPath: "book_id") — полные данные книги для читалки
 */

const DB_NAME = "fb2-library";
const DB_VERSION = 2;
const STORE_BOOKS = "books";
const STORE_PROGRESS = "progress";
const STORE_CONTENT = "content";

/** @type {Promise<IDBDatabase> | null} */
let _dbPromise = null;

function openLibraryDb() {
    if (_dbPromise) {
        return _dbPromise;
    }
    _dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(STORE_BOOKS)) {
                db.createObjectStore(STORE_BOOKS, { keyPath: "book_id" });
            }
            if (!db.objectStoreNames.contains(STORE_PROGRESS)) {
                db.createObjectStore(STORE_PROGRESS, { keyPath: "book_id" });
            }
            if (!db.objectStoreNames.contains(STORE_CONTENT)) {
                db.createObjectStore(STORE_CONTENT, { keyPath: "book_id" });
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => {
            _dbPromise = null;
            reject(req.error);
        };
    });
    return _dbPromise;
}

/**
 * Сохранить карточку книги для полки (метаданные, без контента).
 * Детерминированная запись; added_at сохраняется, если уже был.
 * @param {object} record
 * @returns {Promise<void>}
 */
async function saveBook(record) {
    const db = await openLibraryDb();
    const tx = db.transaction(STORE_BOOKS, "readwrite");
    const store = tx.objectStore(STORE_BOOKS);
    const existing = await idbGet(store, record.book_id);
    store.put({
        ...record,
        added_at: existing?.added_at ?? Date.now(),
    });
    return idbTxDone(tx);
}

/**
 * Сохранить полный контент книги (метаданные читалки + HTML-разметку).
 * @param {string} bookId
 * @param {object} meta          BookMeta (полный, для #book-meta)
 * @param {string} contentHtml   innerHTML для #book-content
 * @param {object} [extra]       { fb2_xml: string, size: number }
 * @returns {Promise<void>}
 */
async function saveBookContent(bookId, meta, contentHtml, extra) {
    const db = await openLibraryDb();
    const tx = db.transaction(STORE_CONTENT, "readwrite");
    tx.objectStore(STORE_CONTENT).put({
        book_id: bookId,
        meta: meta,
        content_html: contentHtml,
        fb2_xml: extra?.fb2_xml ?? null,
        size: extra?.size ?? null,
        added_at: Date.now(),
    });
    return idbTxDone(tx);
}

/**
 * Достать книгу для читалки.
 * @param {string} bookId
 * @returns {Promise<{meta: object, content_html: string, fb2_xml: string|null, size: number|null}|null>}
 */
async function getBookContent(bookId) {
    const db = await openLibraryDb();
    const tx = db.transaction(STORE_CONTENT, "readonly");
    return idbGet(tx.objectStore(STORE_CONTENT), bookId);
}

/**
 * Обновить позицию чтения.
 * @param {string} bookId
 * @param {number} paragraphId
 * @returns {Promise<void>}
 */
async function saveProgress(bookId, paragraphId) {
    const db = await openLibraryDb();
    const tx = db.transaction(STORE_PROGRESS, "readwrite");
    tx.objectStore(STORE_PROGRESS).put({
        book_id: bookId,
        position: paragraphId,
        updated_at: Date.now(),
    });
    return idbTxDone(tx);
}

/**
 * Все книги с позициями чтения, отсортированные по последней активности.
 * @returns {Promise<object[]>}
 */
async function getAllBooks() {
    const db = await openLibraryDb();
    const tx = db.transaction([STORE_BOOKS, STORE_PROGRESS], "readonly");

    const [books, progress] = await Promise.all([
        idbGetAll(tx.objectStore(STORE_BOOKS)),
        idbGetAll(tx.objectStore(STORE_PROGRESS)),
    ]);

    const progressMap = new Map();
    for (const p of progress) {
        progressMap.set(p.book_id, p);
    }

    return books
        .map((book) => {
            const p = progressMap.get(book.book_id);
            return {
                ...book,
                position: p?.position ?? null,
                updated_at: p?.updated_at ?? 0,
            };
        })
        .sort((a, b) => {
            const aa = a.updated_at || a.added_at || 0;
            const bb = b.updated_at || b.added_at || 0;
            return bb - aa;
        });
}

/**
 * Позиция чтения книги (или null).
 * @param {string} bookId
 * @returns {Promise<number|null>}
 */
async function loadBookPosition(bookId) {
    const db = await openLibraryDb();
    const tx = db.transaction(STORE_PROGRESS, "readonly");
    const record = await idbGet(tx.objectStore(STORE_PROGRESS), bookId);
    const pos = record?.position;
    if (pos === null || pos === undefined || !Number.isFinite(pos) || pos < 0) {
        return null;
    }
    return pos;
}

/**
 * Удалить книгу из библиотеки (карточку, позицию и контент).
 * @param {string} bookId
 * @returns {Promise<void>}
 */
async function deleteBook(bookId) {
    const db = await openLibraryDb();
    const tx = db.transaction(
        [STORE_BOOKS, STORE_PROGRESS, STORE_CONTENT],
        "readwrite",
    );
    tx.objectStore(STORE_BOOKS).delete(bookId);
    tx.objectStore(STORE_PROGRESS).delete(bookId);
    tx.objectStore(STORE_CONTENT).delete(bookId);
    return idbTxDone(tx);
}

/**
 * Импортировать FB2-файл: сконвертировать и сохранить в библиотеку.
 * @param {File} file
 * @returns {Promise<{ok: boolean, book_id?: string, title?: string, existed?: boolean, error?: string}>}
 */
async function importFb2File(file) {
    if (!window.Fb2Converter) {
        return { ok: false, error: "Конвертер fb2.js не загружен" };
    }
    let xmlText;
    const buffer = await file.arrayBuffer();
    xmlText = window.Fb2Converter.decodeFb2Buffer(buffer);

    let result;
    try {
        result = window.Fb2Converter.convertFb2Text(xmlText);
    } catch (e) {
        return { ok: false, error: e && e.message ? e.message : String(e) };
    }
    const meta = result.meta;
    if (!meta || !meta.title) {
        return { ok: false, error: "Не удалось прочитать данные FB2" };
    }

    const bookId = await window.Fb2Converter.computeBookId(xmlText);
    meta.book_id = bookId;

    const existed = Boolean(await getBookContent(bookId));

    await saveBookContent(bookId, meta, result.content_html, {
        fb2_xml: xmlText,
        size: buffer.byteLength,
    });
    await saveBook({
        book_id: bookId,
        isbn: meta.isbn,
        publisher: meta.publisher,
        year: meta.year,
        title: meta.title,
        authors: meta.authors,
        cover: meta.cover,
        annotation: meta.annotation,
        genres: meta.genres,
        keywords: meta.keywords,
        sequences: meta.sequences,
        paragraph_count: meta.paragraph_count,
    });

    return {
        ok: true,
        book_id: bookId,
        title: meta.title,
        existed: existed,
    };
}

// ── IDB helpers ──

function idbGet(store, key) {
    return new Promise((resolve, reject) => {
        const req = store.get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

function idbGetAll(store) {
    return new Promise((resolve, reject) => {
        const req = store.getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

function idbTxDone(tx) {
    return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error("aborted"));
    });
}

window.fb2Reader = Object.assign(window.fb2Reader || {}, {
    saveBook,
    saveBookContent,
    getBookContent,
    saveProgress,
    loadBookPosition,
    getAllBooks,
    deleteBook,
    importFb2File,
});