/* Оффлайн-полка: список книг, импорт FB2, поиск, удаление, экспорт. */

(async () => {
    const listEl = document.getElementById("book-list");
    const filterEl = document.getElementById("filter");
    const filterClear = document.getElementById("filter-clear");
    const emptyEl = document.getElementById("empty-msg");
    const storageInfo = document.getElementById("storage-info");
    const swatchesEl = document.getElementById("theme-swatches");
    const addBtn = document.getElementById("add-books");
    const fileInput = document.getElementById("file-input");
    const dropOverlay = document.getElementById("drop-overlay");
    const importStatus = document.getElementById("import-status");

    let allBooks = [];
    let openActionMenu = null;

    // ── Drag & drop import ──
    addBtn.addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", () => {
        if (fileInput.files.length) importFiles(fileInput.files);
        fileInput.value = "";
    });

    let dragDepth = 0;
    window.addEventListener("dragenter", (e) => {
        e.preventDefault();
        dragDepth++;
        dropOverlay.classList.add("visible");
    });
    window.addEventListener("dragover", (e) => e.preventDefault());
    window.addEventListener("dragleave", () => {
        dragDepth = Math.max(0, dragDepth - 1);
        if (dragDepth === 0) dropOverlay.classList.remove("visible");
    });
    window.addEventListener("drop", (e) => {
        e.preventDefault();
        dragDepth = 0;
        dropOverlay.classList.remove("visible");
        const files = e.dataTransfer?.files;
        if (files && files.length) importFiles(files);
    });

    // ── Search index ──
    /** @type {Map<string, {title: string, authors: string[], sequences: string[], authorKey: string, seqMap: Map<string, number>, seqKey: string}>} */
    let searchIndex = new Map();

    function buildSearchIndex(books) {
        searchIndex = new Map();
        for (const book of books) {
            const title = (book.title || "").toLowerCase();
            const authors = (book.authors || [])
                .map((a) => formatAuthor(a).toLowerCase())
                .filter(Boolean);
            const sequences = flattenSequenceNames(book.sequences || []).map((s) => s.toLowerCase());
            const authorKey = (book.authors || []).map(formatAuthor).sort().join("\0");
            const seqMap = flattenSequenceEntries(book.sequences || []);
            const seqKey = [...seqMap.keys()].sort().join("\0");
            searchIndex.set(book.book_id, { title, authors, sequences, authorKey, seqMap, seqKey });
        }
    }

    function flattenSequenceNames(sequences) {
        const names = [];
        for (const seq of sequences) {
            if (seq.name) names.push(seq.name);
            if (seq.child) names.push(...flattenSequenceNames([seq.child]));
        }
        return names;
    }

    /** Levenshtein distance. */
    function levenshtein(a, b) {
        const m = a.length, n = b.length;
        if (m === 0) return n;
        if (n === 0) return m;
        let prev = Array.from({ length: n + 1 }, (_, j) => j);
        let curr = new Array(n + 1);
        for (let i = 1; i <= m; i++) {
            curr[0] = i;
            for (let j = 1; j <= n; j++) {
                curr[j] = a[i - 1] === b[j - 1]
                    ? prev[j - 1]
                    : 1 + Math.min(prev[j], curr[j - 1], prev[j - 1]);
            }
            [prev, curr] = [curr, prev];
        }
        return prev[n];
    }

    /** Fuzzy score for a field: per query word, best word similarity (0..1). */
    function fuzzyFieldScore(queryWords, text) {
        const fieldWords = text.split(/\s+/).filter(Boolean);
        if (fieldWords.length === 0 || queryWords.length === 0) return 0;
        let total = 0;
        for (const qw of queryWords) {
            let bestSim = 0;
            for (const fw of fieldWords) {
                const dist = levenshtein(qw, fw);
                const maxLen = Math.max(qw.length, fw.length);
                const sim = maxLen > 0 ? 1 - dist / maxLen : 0;
                if (sim > bestSim) bestSim = sim;
            }
            total += bestSim;
        }
        return total / queryWords.length;
    }

    /** Flattens nested sequence chains into a Map<name, number>. */
    function flattenSequenceEntries(sequences) {
        const map = new Map();
        for (const seq of sequences) {
            let current = seq;
            while (current) {
                if (current.name) map.set(current.name, current.number);
                current = current.child;
            }
        }
        return map;
    }

    /** Search books by query, sorted by relevance (substring + fuzzy). */
    function searchBooks(query, bookList) {
        const q = query.toLowerCase().trim();
        if (!q) return [];
        const qWords = q.split(/\s+/).filter(Boolean);
        const results = [];

        for (const book of bookList) {
            const idx = searchIndex.get(book.book_id);
            if (!idx) continue;

            let score = 0;
            if (idx.title.includes(q)) score = 1.0;
            else if (idx.authors.some((a) => a.includes(q))) score = 0.95;
            else if (idx.sequences.some((s) => s.includes(q))) score = 0.9;
            else {
                const titleSim = fuzzyFieldScore(qWords, idx.title);
                const authorSim = idx.authors.reduce((best, a) => Math.max(best, fuzzyFieldScore(qWords, a)), 0);
                const seqSim = idx.sequences.reduce((best, s) => Math.max(best, fuzzyFieldScore(qWords, s)), 0);
                score = Math.max(titleSim, authorSim, seqSim);
            }

            if (score > 0.5) results.push({ book, score });
        }

        results.sort((a, b) => b.score - a.score);
        return results.map((r) => r.book);
    }

    // ── Theme swatches ──
    const storedSettings = JSON.parse(localStorage.getItem("fb2ReaderSettings") || "{}");
    let savedTheme = storedSettings.theme || "auto";
    updateSwatchSelected(savedTheme);

    function resolveTheme(value) {
        if (value === "auto") {
            return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
        }
        return value;
    }

    function applyTheme(value) {
        const themes = ["light", "parchment", "gray", "dark"];
        themes.forEach((t) => document.documentElement.classList.remove(`theme-${t}`));
        document.documentElement.classList.add(`theme-${resolveTheme(value)}`);
    }

    swatchesEl.addEventListener("click", (e) => {
        const btn = e.target.closest(".theme-swatch");
        if (!btn) return;
        savedTheme = btn.dataset.theme;
        applyTheme(savedTheme);
        const s = JSON.parse(localStorage.getItem("fb2ReaderSettings") || "{}");
        s.theme = savedTheme;
        localStorage.setItem("fb2ReaderSettings", JSON.stringify(s));
        updateSwatchSelected(savedTheme);
    });

    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
        if (savedTheme === "auto") applyTheme("auto");
    });

    function updateSwatchSelected(value) {
        swatchesEl.querySelectorAll(".theme-swatch").forEach((s) => {
            s.classList.toggle("selected", s.dataset.theme === value);
        });
    }

    // ── Load books ──
    async function reload() {
        try {
            allBooks = await fb2Reader.getAllBooks();
            buildSearchIndex(allBooks);
        } catch (e) {
            console.error("Failed to load book index", e);
            allBooks = [];
        }
        renderFiltered();
        updateStorageEstimate();
    }

    // ── Import ──
    async function importFiles(fileList) {
        const files = Array.from(fileList).filter((f) =>
            /\.(fb2|xml)$/i.test(f.name) || f.type === "application/x-fictionbook+xml",
        );
        const skipped = fileList.length - files.length;

        let ok = 0, err = 0;
        const lines = [];
        for (const file of files) {
            try {
                const res = await fb2Reader.importFb2File(file);
                if (res.ok) {
                    ok++;
                    lines.push(`<div class="ok">✓ ${escapeHtml(res.title || file.name)}${res.existed ? " (обновлено)" : ""}</div>`);
                } else {
                    err++;
                    lines.push(`<div class="err">✕ ${escapeHtml(file.name)} — ${escapeHtml(res.error || "ошибка")}</div>`);
                }
            } catch (e) {
                err++;
                lines.push(`<div class="err">✕ ${escapeHtml(file.name)} — ${escapeHtml(e && e.message ? e.message : String(e))}</div>`);
            }
        }
        if (skipped) lines.push(`<div class="warn">Пропущено не-FB2 файлов: ${skipped}</div>`);
        if (lines.length) {
            importStatus.innerHTML = lines.join("");
            importStatus.classList.add("visible");
        }
        await reload();
        const msg = ok ? `Добавлено книг: ${ok}.` : "";
        if (err) {
            showToast(err + " файл(ов) не удалось прочитать.", "err");
        }
        void msg;
    }

    function escapeHtml(s) {
        return String(s)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
    }

    // ── Filtering ──
    filterEl.addEventListener("input", () => {
        const hasText = filterEl.value.trim().length > 0;
        filterClear.style.display = hasText ? "block" : "none";
        renderFiltered();
    });

    filterClear.addEventListener("click", () => {
        filterEl.value = "";
        filterClear.style.display = "none";
        renderFiltered();
    });

    function renderFiltered() {
        const q = filterEl.value.trim();
        const books = q ? searchBooks(q, allBooks) : allBooks;
        emptyEl.textContent = q
            ? "Ничего не найдено."
            : "Библиотека пуста. Нажмите «Добавить FB2» или перетащите файлы .fb2 сюда.";
        renderList(books);
    }

    // ── Rendering ──
    function el(tag, cls, content) {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        if (content != null) {
            if (typeof content === "string") e.textContent = content;
            else if (Array.isArray(content)) {
                for (const c of content) if (c) e.append(c);
            } else e.append(content);
        }
        return e;
    }

    const PLACEHOLDER_SVG = '<svg width="120" height="200" viewBox="0 0 120 200" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="1" y="1" width="118" height="198" rx="4" fill="currentColor" opacity="0.08"/><rect x="1" y="1" width="18" height="198" rx="4" fill="currentColor" opacity="0.18"/><rect x="1" y="1" width="118" height="198" rx="4" stroke="currentColor" stroke-width="2" opacity="0.4"/><line x1="30" y1="60" x2="100" y2="60" stroke="currentColor" stroke-width="2" stroke-linecap="round" opacity="0.3"/><line x1="30" y1="76" x2="100" y2="76" stroke="currentColor" stroke-width="2" stroke-linecap="round" opacity="0.3"/><line x1="30" y1="92" x2="78" y2="92" stroke="currentColor" stroke-width="2" stroke-linecap="round" opacity="0.3"/></svg>';

    function renderList(books) {
        openActionMenu = null;
        listEl.innerHTML = "";
        if (!books.length) { emptyEl.style.display = "block"; return; }
        emptyEl.style.display = "none";

        for (const book of books) {
            const bookUrl = `read.html?id=${encodeURIComponent(book.book_id)}`;

            let cover;
            if (book.cover) {
                cover = Object.assign(el("img", "book-cover"), { src: book.cover, alt: "" });
                cover.addEventListener("error", () => {
                    const ph = el("div", "book-cover-placeholder");
                    ph.innerHTML = PLACEHOLDER_SVG;
                    cover.replaceWith(ph);
                });
            } else {
                cover = el("div", "book-cover-placeholder");
                cover.innerHTML = PLACEHOLDER_SVG;
            }

            let authorsEl = null;
            if (book.authors?.length) {
                authorsEl = el("div", "book-authors");
                book.authors.map(formatAuthor).filter(Boolean).forEach((name, i) => {
                    if (i) authorsEl.append(", ");
                    const s = el("span", "book-link", name);
                    s.addEventListener("click", () => setSearchQuery(name));
                    authorsEl.append(s);
                });
            }

            let seqEl = null;
            if (book.sequences?.length) {
                seqEl = el("div", "book-sequences");
                book.sequences.forEach((seq, i) => {
                    if (i) seqEl.append("; ");
                    appendSequenceLinks(seqEl, seq);
                });
            }

            let annEl;
            if (book.annotation) {
                annEl = el("div", "book-annotation");
                annEl.innerHTML = book.annotation;
            } else {
                annEl = el("p", "book-annotation-missing", "Аннотация отсутствует");
            }

            const pct = computeProgress(book);
            const progress = book.position > 1 ? el("span", "book-progress", `Прочитано: ${pct}%`) : null;
            const readBtn = Object.assign(el("a", "btn-read"), { href: bookUrl, textContent: "Читать" });

            const info = el("div", "book-info", [
                cover,
                el("div", "book-title", book.title),
                authorsEl, seqEl, annEl,
                el("div", "book-footer", [progress, readBtn]),
            ]);

            const card = el("div", "book-card", [
                info,
                el("div", "book-actions", buildActionMenu(book)),
            ]);

            listEl.append(el("li", null, card));
        }
    }

    function setSearchQuery(text) {
        filterEl.value = text;
        filterClear.style.display = "block";
        filterEl.scrollIntoView({ behavior: "instant", block: "center" });
        renderFiltered();
    }

    function buildActionMenu(book) {
        const menu = el("div", "action-menu");
        const btn = Object.assign(el("button", "action-menu-btn", "⋮"), { type: "button", title: "Действия" });

        const exportBtn = Object.assign(
            el("button", "action-menu-item", "Скачать FB2 (бэкап)"),
            { type: "button" },
        );
        exportBtn.addEventListener("click", async (e) => {
            e.stopPropagation();
            await exportBook(book);
            closeMenu(menu);
        });

        const delBtn = Object.assign(
            el("button", "action-menu-item action-menu-item-danger", "Удалить из библиотеки"),
            { type: "button" },
        );
        delBtn.addEventListener("click", async (e) => {
            e.stopPropagation();
            if (!confirm(`Удалить «${book.title}» из библиотеки?`)) return;
            await fb2Reader.deleteBook(book.book_id);
            allBooks = allBooks.filter((b) => b.book_id !== book.book_id);
            searchIndex.delete(book.book_id);
            renderFiltered();
            updateStorageEstimate();
        });

        btn.addEventListener("click", (e) => {
            e.stopPropagation();
            if (openActionMenu && openActionMenu !== menu) openActionMenu.classList.remove("open");
            const nowOpen = menu.classList.toggle("open");
            openActionMenu = nowOpen ? menu : null;
        });

        menu.append(btn, el("ul", "action-menu-list", [
            el("li", null, exportBtn),
            el("li", null, delBtn),
        ]));
        return menu;
    }

    function closeMenu(menu) {
        menu.classList.remove("open");
        if (openActionMenu === menu) openActionMenu = null;
    }

    document.addEventListener("click", () => {
        if (openActionMenu) {
            openActionMenu.classList.remove("open");
            openActionMenu = null;
        }
    });

    // ── Export / misc ──
    async function exportBook(book) {
        try {
            const rec = await fb2Reader.getBookContent(book.book_id);
            const xml = rec && rec.fb2_xml;
            if (!xml) throw new Error("исходный FB2 не сохранён");
            const blob = new Blob([xml], { type: "application/x-fictionbook+xml" });
            const a = document.createElement("a");
            a.href = URL.createObjectURL(blob);
            const safe = (book.title || "book").replace(/[\\/:*?"<>|]+/g, "_").slice(0, 80);
            a.download = `${safe}.fb2`;
            document.body.append(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(a.href), 5000);
        } catch (e) {
            showToast("Не удалось выгрузить FB2: " + (e && e.message ? e.message : e), "err");
        }
    }

    function showToast(msg, kind) {
        importStatus.innerHTML = `<div class="${kind}">${escapeHtml(msg)}</div>`;
        importStatus.classList.add("visible");
        setTimeout(() => importStatus.classList.remove("visible"), 6000);
    }

    function computeProgress(book) {
        const pos = book.position;
        const count = book.paragraph_count;
        if (!pos || !count) return 0;
        return Math.min(100, Math.round((pos / count) * 100));
    }

    function formatAuthor(a) {
        return [a.name, a.nickname, a.surname].filter(Boolean).join(" ");
    }

    function appendSequenceLinks(container, seq) {
        const s = el("span", "book-link", seq.number != null ? `${seq.name}: ${seq.number}` : seq.name);
        s.addEventListener("click", () => setSearchQuery(seq.name));
        container.append(s);
        if (seq.child) {
            container.append(" — ");
            appendSequenceLinks(container, seq.child);
        }
    }

    function formatBytes(bytes) {
        if (bytes < 1024) return `${bytes} Б`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} КБ`;
        if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
        return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} ГБ`;
    }

    async function updateStorageEstimate() {
        if (!navigator.storage || !navigator.storage.estimate) return;
        try {
            const est = await navigator.storage.estimate();
            storageInfo.textContent = `Занято ${formatBytes(est.usage)} из ${formatBytes(est.quota)}`;
        } catch { /* ignore */ }
    }

    await reload();
})();