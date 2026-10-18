/**
 * IndexedDB helper for the offline book shelf.
 *
 * DB: "fb2-library", version 1
 * Stores:
 *   "books" (keyPath: "book_id") — immutable metadata (server-sourced)
 *     book_id         – string (key)
 *     isbn            – string | null
 *     title           – string
 *     authors         – Author[]
 *     cover           – string | null  ({img} part in /book/{id}/images/{img})
 *     annotation      – string | null  (HTML)
 *     genres          – string[]
 *     keywords        – string[]
 *     sequences       – Sequence[]  (recursive: {name, number?, child?})
 *     paragraph_count – number
 *
 *   "progress" (keyPath: "book_id") — reading state (client-sourced)
 *     book_id         – string (key)
 *     position        – number  (paragraph ID, e.g. 42)
 *     updated_at      – number  (UTC millis, Date.now())
 */

const DB_NAME = "fb2-library";
const DB_VERSION = 1;
const STORE_BOOKS = "books";
const STORE_PROGRESS = "progress";

/** @type {Promise<IDBDatabase> | null} */
let _dbPromise = null;

/**
 * Open (or create) the database. Caches the promise so only one
 * connection is created per page.
 * @returns {Promise<IDBDatabase>}
 */
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
 * Save or update book metadata in the index.
 * Pure overwrite — metadata is server-sourced and deterministic.
 * @param {object} record
 * @returns {Promise<void>}
 */
async function saveBook(record) {
    const db = await openLibraryDb();
    const tx = db.transaction(STORE_BOOKS, "readwrite");
    tx.objectStore(STORE_BOOKS).put(record);
    return idbTxDone(tx);
}

/**
 * Update reading position for a book (lightweight write).
 * @param {string} bookId
 * @param {number} paragraphId  e.g. 42
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
 * Get all books from the index, joined with their reading progress.
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

    return books.map((book) => {
        const p = progressMap.get(book.book_id);
        return {
            ...book,
            position: p?.position ?? null,
            updated_at: p?.updated_at ?? 0,
        };
    });
}

/**
 * Load reading position for a book from the index.
 * @param {string} bookId
 * @returns {Promise<number|null>} Paragraph number or null if missing/invalid
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
 * Delete a book from the index (both metadata and progress).
 * @param {string} bookId
 * @returns {Promise<void>}
 */
async function deleteBook(bookId) {
    const db = await openLibraryDb();
    const tx = db.transaction([STORE_BOOKS, STORE_PROGRESS], "readwrite");
    tx.objectStore(STORE_BOOKS).delete(bookId);
    tx.objectStore(STORE_PROGRESS).delete(bookId);
    return idbTxDone(tx);
}

// ── IDB helpers ──

/** Promisified IDBObjectStore.get */
function idbGet(store, key) {
    return new Promise((resolve, reject) => {
        const req = store.get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

/** Promisified IDBObjectStore.getAll */
function idbGetAll(store) {
    return new Promise((resolve, reject) => {
        const req = store.getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

/** Wait for a transaction to complete. */
function idbTxDone(tx) {
    return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

// Expose helpers for non-module scripts (reader/shelf pages).
window.fb2Reader = Object.assign(window.fb2Reader || {}, {
    saveBook,
    saveProgress,
    loadBookPosition,
    getAllBooks,
    deleteBook,
});
