/*
 * Behaviour for the FB2 reader.
 *
 * This script wires up the settings and table of contents panels, handles
 * user interactions, applies preferences to the book container and
 * persists them to localStorage. It also manages note modals and UI chrome.
 */

/* global fb2Reader */

/** @typedef {{ paragraphs: string[] }} TocTitle */
/** @typedef {{ id: string, title: TocTitle, children: TocNode[] }} TocNode */
/** @typedef {{ id: (string|null), name: (string|null), surname: (string|null), nickname: (string|null) }} Author */
/** @typedef {{ name: string, number: (number|null|undefined), child: (Sequence|null) }} Sequence */
/** @typedef {{ start: number, end: number }} ParagraphRange */
/** @typedef {{ id: string, title: TocTitle, html: string, backrefs: string[] }} Note */
/** @typedef {{ width: number, height: number }} ImageSize */
/** @typedef {{ id: string, size: ImageSize }} ImageInfo */
/**
 * @typedef {Object} BookMeta
 * @property {string} book_id
 * @property {string} title
 * @property {(string|null)} isbn
 * @property {(string|null)} publisher
 * @property {(number|null)} year
 * @property {Author[]} authors
 * @property {string[]} genres
 * @property {TocNode[]} toc
 * @property {string[]} keywords
 * @property {string[]} section_ids
 * @property {Note[]} notes
 * @property {ImageInfo[]} images
 * @property {number} paragraph_count
 * @property {(ParagraphRange|null)[]} section_ranges
 * @property {string|null} annotation
 * @property {string|null} cover
 * @property {Sequence[]} sequences
 */

/**
 * Parse and validate BookMeta from JSON string.
 * Returns a fully typed object for VSCode (JSDoc).
 *
 * @param {string} jsonText
 * @returns {BookMeta}
 */
function parseBookMeta(jsonText) {
    const raw = JSON.parse(jsonText);

    // Ensure the top-level JSON value is an object.
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        throw new Error(
            "Invalid metadata: top-level JSON value must be an object",
        );
    }

    // Basic sanity checks.
    if (typeof raw.book_id !== "string") {
        throw new Error("Missing book_id in metadata");
    }
    if (typeof raw.title !== "string") {
        throw new Error("Missing or invalid title in metadata");
    }
    if (
        typeof raw.isbn !== "string" &&
        raw.isbn !== null &&
        raw.isbn !== undefined
    ) {
        throw new Error("Invalid isbn in metadata");
    }
    if (
        typeof raw.publisher !== "string" &&
        raw.publisher !== null &&
        raw.publisher !== undefined
    ) {
        throw new Error("Invalid publisher in metadata");
    }
    if (
        typeof raw.year !== "number" &&
        raw.year !== null &&
        raw.year !== undefined
    ) {
        throw new Error("Invalid year in metadata");
    }
    if (!Array.isArray(raw.authors)) {
        throw new Error("Missing or invalid authors in metadata");
    }
    if (!Array.isArray(raw.genres) && raw.genres !== undefined) {
        throw new Error("Invalid genres in metadata");
    }
    if (!Array.isArray(raw.toc)) {
        throw new Error("Missing or invalid toc in metadata");
    }
    if (!Array.isArray(raw.keywords) && raw.keywords !== undefined) {
        throw new Error("Invalid keywords in metadata");
    }
    if (!Array.isArray(raw.section_ids)) {
        throw new Error("Missing or invalid section_ids in metadata");
    }
    if (!Array.isArray(raw.notes)) {
        throw new Error("Missing or invalid notes in metadata");
    }
    if (!Array.isArray(raw.images)) {
        throw new Error("Missing or invalid images in metadata");
    }
    if (typeof raw.paragraph_count !== "number") {
        throw new Error("Missing or invalid paragraph_count in metadata");
    }
    if (!Array.isArray(raw.section_ranges)) {
        throw new Error("Missing or invalid section_ranges in metadata");
    }
    /** @type {BookMeta} */
    const meta = {
        book_id: raw.book_id,
        title: raw.title,
        isbn: raw.isbn ?? null,
        publisher: raw.publisher ?? null,
        year: raw.year ?? null,
        authors: raw.authors,
        genres: raw.genres ?? [],
        toc: raw.toc,
        keywords: raw.keywords ?? [],
        section_ids: raw.section_ids,
        notes: raw.notes,
        images: raw.images,
        paragraph_count: raw.paragraph_count,
        section_ranges: raw.section_ranges,
        annotation: raw.annotation ?? null,
        cover: raw.cover ?? null,
        sequences: raw.sequences ?? [],
    };

    return meta;
}

/**
 * Universal bounds-checked access.
 * Throws a RangeError if the index is out of bounds
 * or a ReferenceError if the key is not found.
 *
 * @template T
 * @param {T[] | Record<string, T> | Map<any, T>} container
 * @param {number|string} key
 * @param {string} [msg]
 * @returns {T}
 */
function checkedGet(container, key, msg = "access") {
    if (Array.isArray(container)) {
        if (typeof key !== "number" || !Number.isInteger(key)) {
            throw new TypeError(`${msg}: array index must be integer`);
        }
        if (key < 0 || key >= container.length) {
            throw new RangeError(
                `${msg}: ${key} out of bounds (len=${container.length})`,
            );
        }
    }

    if (container instanceof Map) {
        if (!container.has(key)) {
            throw new ReferenceError(`${msg}: key "${String(key)}" not found`);
        }
        return container.get(key);
    }

    if (typeof container === "object" && container !== null) {
        if (!Object.prototype.hasOwnProperty.call(container, key)) {
            throw new ReferenceError(`${msg}: key "${String(key)}" not found`);
        }
        // @ts-ignore — key existence checked
        return container[key];
    }

    throw new TypeError(
        `${msg}: unsupported container, typeof ${typeof container} given`,
    );
}

/**
 * This script assumes the presence of certain elements in the DOM,
 * such as the book container, settings panel, TOC panel, and various buttons.
 * To avoid silent errors later on, we check for the presence of these elements at startup
 * and throw if any are missing.
 * This way, if the HTML structure changes or an element is accidentally removed,
 * it will be immediately obvious in the console.
 * @returns {HTMLElement} The element with the specified ID
 */
function getElementById(id) {
    const el = document.getElementById(id);
    if (!el) {
        throw new Error(
            `Required element with id '#${id}' not found in the document.`,
        );
    }
    return el;
}

document.addEventListener("DOMContentLoaded", async () => {
    const container = getElementById("book-container");
    const bookContent = getElementById("book-content");
    const bookMeta = getElementById("book-meta");
    const readerHeader = getElementById("reader-header");
    const settingsToggle = getElementById("settings-toggle");
    const settingsPanel = getElementById("settings-panel");
    const settingsClose = getElementById("settings-close");
    const tocBody = getElementById("toc-body");
    const tocList = getElementById("toc-list");
    const tocToggle = getElementById("toc-toggle");
    const tocPanel = getElementById("toc-panel");
    const tocClose = getElementById("toc-close");
    const overlay = getElementById("overlay");
    const fontSizeDisplay = getElementById("font-size-display");
    const fontSizeDecrease = getElementById("font-size-decrease");
    const fontSizeIncrease = getElementById("font-size-increase");
    const columnsGroup = getElementById("columns-group");
    const fullscreenToggle = getElementById("fullscreen-toggle");
    const fullscreenEnterIcon = getElementById("fullscreen-enter-icon");
    const fullscreenExitIcon = getElementById("fullscreen-exit-icon");
    const resetSettingsButton = getElementById("reset-settings-button");
    const pageNavPrev = getElementById("page-nav-prev");
    const pageNavNext = getElementById("page-nav-next");
    // Footer elements
    const progressChapter = getElementById("progress-chapter");
    const progressValue = getElementById("progress-value");
    // Elements related to the note modal
    const modal = getElementById("note-modal");
    const modalBody = getElementById("modal-body");
    const modalClose = getElementById("modal-close");

    // Default settings.  These are used if nothing has been saved in localStorage.
    const defaults = {
        theme: "auto", // "auto", "light", "parchment", "gray", "dark"
        font: "cactus", // "cactus", "spectral", "inter", "roboto-mono"
        fontSize: 20, // px
        lineHeight: "normal",
        hyphenation: "no", // "no" or "yes"
        alignment: "justify", // "left" or "justify"
        readingMode: "page", // "scroll", "chapter", or "page"
        columns: "2", // "1" or "2" (effective only in page mode on wide screens)
    };

    // Parse book metadata once. The server injects JSON into the book-meta script tag.
    const meta = parseBookMeta(bookMeta.textContent);

    // Start loading reading position from IDB immediately (before any sync work).
    const positionPromise = fb2Reader
        .loadBookPosition(meta.book_id)
        .catch(() => null);

    // Load image sources from data-src attributes
    function loadImageSources() {
        const images = bookContent.querySelectorAll("img[data-src]");
        images.forEach((img) => {
            const imgId = img.getAttribute("data-src");
            if (imgId) {
                img.src = `/book/${meta.book_id}/images/${imgId}`;
                img.removeAttribute("data-src");
            }
        });
    }
    // Call after DOM elements are ready
    loadImageSources();

    // Persist book metadata to IndexedDB for offline shelf.
    fb2Reader
        .saveBook({
            book_id: meta.book_id,
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
        })
        .catch(() => {}); // best-effort, don't block reader

    // On the very first visit the SW hasn't intercepted the page fetch yet,
    // so the book HTML is missing from the cache.  Once the SW is active
    // (navigator.serviceWorker.ready), ask it to cache the current URL so
    // the book is fully available offline immediately after first load.
    if (navigator.serviceWorker) {
        navigator.serviceWorker.ready
            .then((reg) => {
                reg.active.postMessage({
                    type: "CACHE_PAGE",
                    url: location.href,
                });
            })
            .catch(() => {});
    }

    // Load settings from localStorage, falling back to defaults.
    const currentSettings = {
        ...defaults,
        ...JSON.parse(localStorage.getItem("fb2ReaderSettings") || "{}"),
    };

    // Debounced pagination recomputation.  Declared early because
    // applySettingsSnapshot (called during init) references it via
    // requestLayoutRecalc.
    //
    // Holds the in-flight recalc request.  Null when idle.
    let recalcPending = null;

    function cancelPendingRecalc() {
        if (!recalcPending) {
            return;
        }
        if (recalcPending.rafId) {
            cancelAnimationFrame(recalcPending.rafId);
        }
        if (recalcPending.timeoutId) {
            clearTimeout(recalcPending.timeoutId);
        }
        recalcPending = null;
    }

    function applySettingsSnapshot(
        settings,
        { persist = true, restorePosition = true } = {},
    ) {
        setTheme(settings.theme, false);
        setFont(settings.font, false, false);
        setAlignment(settings.alignment, false, false);
        setLineHeight(settings.lineHeight, false, false);
        setHyphenation(settings.hyphenation, false, false);
        setFontSize(settings.fontSize, false, false);
        setColumns(settings.columns, false, false);
        setReadingMode(settings.readingMode, false, false);

        if (persist) {
            saveSettings();
        }

        if (!restorePosition) {
            return;
        }

        // Route through requestLayoutRecalc so that a racing resize event
        // coalesces into the same refresh.  In scroll mode this runs
        // synchronously; in page mode it goes through the debounce +
        // double-rAF pipeline.
        requestLayoutRecalc();
    }

    // Pagination state (minimal: only page index needed for navigation)
    let currentPage = 0;
    let currentChapterIndex = -1;
    const totalParagraphs = meta.paragraph_count;

    // Current reading position, populated from IDB at startup and updated on every save.
    let savedPosition = null;

    const tocTitleMap = buildTocTitleMap();

    /** Cached array of section DOM elements (queried once). */
    let cachedSectionElements = null;
    function getSectionElements() {
        if (!cachedSectionElements) {
            cachedSectionElements = Array.from(
                bookContent.querySelectorAll("section[id]"),
            );
        }
        return cachedSectionElements;
    }

    /**
     * Show only the section at `chapterIdx` (and its ancestors).
     * All other sections are hidden via display:none.
     * @param {number} chapterIdx Index into meta.section_ids
     */
    function showChapter(chapterIdx) {
        const sections = getSectionElements();
        const currentId = meta.section_ids[chapterIdx] || "";
        currentChapterIndex = chapterIdx;

        // Walk up from target to find ancestor section IDs.
        const ancestorIds = new Set();
        const targetEl = document.getElementById(currentId);
        if (targetEl) {
            let parent = targetEl.parentElement;
            while (parent && parent !== bookContent) {
                if (parent.tagName === "SECTION" && parent.id) {
                    ancestorIds.add(parent.id);
                }
                parent = parent.parentElement;
            }
        }

        for (const el of sections) {
            const isCurrent = el.id === currentId;
            const isAncestor = ancestorIds.has(el.id);
            el.classList.toggle("current-chapter", isCurrent);
            el.classList.toggle("ancestor-chapter", isAncestor);
        }

        highlightCurrentChapterInTOC();
    }

    /**
     * Restore all sections to visible (when leaving chapter mode).
     */
    function showAllChapters() {
        const sections = getSectionElements();
        for (const el of sections) {
            el.classList.remove("current-chapter", "ancestor-chapter");
        }
    }

    /**
     * Navigate to a chapter in chapter mode.
     * @param {number} chapterIdx Index into meta.section_ids
     */
    function goToChapter(chapterIdx, closeUi = true) {
        const clamped = Math.max(
            0,
            Math.min(chapterIdx, meta.section_ids.length - 1),
        );
        navigateToElement(meta.section_ids[clamped], closeUi);
    }

    /**
     * Inject prev/next chapter navigation elements at the end of each section.
     * These are shown only in chapter mode.
     */
    function injectChapterNavElements() {
        const sectionIds = meta.section_ids;
        const total = sectionIds.length;

        for (let idx = 0; idx < total; idx++) {
            const sectionId = sectionIds[idx];
            const section = document.getElementById(sectionId);
            if (!section) {
                continue;
            }

            const nav = document.createElement("div");
            nav.className = "chapter-nav";

            const prevBtn = document.createElement("button");
            prevBtn.className = "chapter-nav-btn";
            prevBtn.innerHTML =
                '<svg class="nav-arrow" viewBox="0 0 24 24"><path d="M15.41 7.41 14 6l-6 6 6 6 1.41-1.41L10.83 12z"/></svg>Предыдущая';
            if (idx > 0) {
                prevBtn.addEventListener("click", () => {
                    goToChapter(idx - 1);
                });
            } else {
                prevBtn.style.visibility = "hidden";
            }

            const nextBtn = document.createElement("button");
            nextBtn.className = "chapter-nav-btn";
            nextBtn.innerHTML =
                'Следующая<svg class="nav-arrow" viewBox="0 0 24 24"><path d="M8.59 16.59 10 18l6-6-6-6-1.41 1.41L13.17 12z"/></svg>';
            if (idx < total - 1) {
                nextBtn.addEventListener("click", () => {
                    goToChapter(idx + 1);
                });
            } else {
                nextBtn.style.visibility = "hidden";
            }

            nav.appendChild(prevBtn);
            nav.appendChild(nextBtn);
            section.appendChild(nav);
        }
    }

    let cachedLayoutStyles = null;
    function getLayoutStyles() {
        if (cachedLayoutStyles) {
            return cachedLayoutStyles;
        }
        const style = window.getComputedStyle(bookContent);
        cachedLayoutStyles = {
            paddingLeft: parseFloat(style.paddingLeft) || 0,
            paddingRight: parseFloat(style.paddingRight) || 0,
            paddingTop: parseFloat(style.paddingTop) || 0,
            paddingBottom: parseFloat(style.paddingBottom) || 0,
            columnGap: parseFloat(style.columnGap) || 0,
        };
        return cachedLayoutStyles;
    }

    let cachedParagraphs = null;
    function getCachedParagraphs() {
        if (!cachedParagraphs) {
            cachedParagraphs = Array.from(
                bookContent.querySelectorAll("p[id]"),
            );
        }
        return cachedParagraphs;
    }

    /** Paragraphs filtered by chapter index. Lazily populated, never invalidated
     *  (both cachedParagraphs and meta.section_ranges are stable). */
    const chapterParagraphCache = new Map();
    function getChapterParagraphs(chapterIdx) {
        let result = chapterParagraphCache.get(chapterIdx);
        if (result) {
            return result;
        }
        const range = meta.section_ranges[chapterIdx];
        if (!range) {
            return null;
        }
        result = getCachedParagraphs().filter((p) => {
            const num = parseInt(p.id.substring(1), 10);
            return num >= range.start && num <= range.end;
        });
        chapterParagraphCache.set(chapterIdx, result);
        return result;
    }

    /**
     * Find the ID of the paragraph currently visible in the viewport.
     * In scroll mode, finds the paragraph at the top of the viewport.
     * In page mode, finds the first paragraph on the current page.
     * In chapter mode, finds the paragraph at the top of the viewport (like scroll).
     * @returns {string|null} The ID of the visible paragraph or null
     */
    function getCurrentVisibleParagraphId() {
        // In chapter mode, only consider paragraphs in the current section.
        // Hidden paragraphs (display: none) report getBoundingClientRect as
        // all zeros, which corrupts the binary search.
        const paragraphs =
            currentSettings.readingMode === "chapter"
                ? getChapterParagraphs(currentChapterIndex)
                : getCachedParagraphs();
        if (!paragraphs || paragraphs.length === 0) {
            return null;
        }

        if (currentSettings.readingMode === "page") {
            const pageScrollLeft = getScrollPositionForPage(currentPage);
            // Instead of resetting scrollLeft to 0 (which forces a ~50ms
            // reflow), read paragraph positions at the current scroll offset
            // and compensate by adding bookContent.scrollLeft.
            const currentScroll = bookContent.scrollLeft;
            const ls = getLayoutStyles();
            const containerLeft = bookContent.getBoundingClientRect().left;
            const paddingLeft = ls.paddingLeft;
            const pageDocLeft = pageScrollLeft + paddingLeft;
            const d = getDimensions();
            const pageWidth = d.boundingWidth - paddingLeft - ls.paddingRight;
            const pageDocRight = pageDocLeft + Math.max(0, pageWidth);

            // Paragraph positions are relative to container at scrollLeft=0,
            // so: docLeft = (rect.left - containerLeft) + currentScroll
            const getParagraphLeft = (paragraph) =>
                paragraph.getBoundingClientRect().left -
                containerLeft +
                currentScroll;
            const getParagraphRight = (paragraph) =>
                paragraph.getBoundingClientRect().right -
                containerLeft +
                currentScroll;

            let left = 0;
            let right = paragraphs.length - 1;
            while (left < right) {
                const mid = Math.floor((left + right) / 2);
                if (getParagraphLeft(paragraphs[mid]) < pageDocLeft) {
                    left = mid + 1;
                } else {
                    right = mid;
                }
            }

            if (
                left < paragraphs.length &&
                getParagraphLeft(paragraphs[left]) < pageDocRight
            ) {
                return paragraphs[left].id;
            }

            left = 0;
            right = paragraphs.length - 1;
            while (left < right) {
                const mid = Math.floor((left + right) / 2);
                if (getParagraphRight(paragraphs[mid]) <= pageDocLeft) {
                    left = mid + 1;
                } else {
                    right = mid;
                }
            }
            return paragraphs[left].id;
        }

        // In scroll mode, use binary search against paragraph offsets.
        const viewportTop = window.scrollY;

        let left = 0;
        let right = paragraphs.length - 1;

        while (left < right) {
            const mid = Math.floor((left + right) / 2);
            const rect = paragraphs[mid].getBoundingClientRect();
            const elementTop = rect.top + window.scrollY;

            if (elementTop < viewportTop) {
                left = mid + 1;
            } else {
                right = mid;
            }
        }

        if (left > 0) {
            const prevRect = paragraphs[left - 1].getBoundingClientRect();
            const prevTop = prevRect.top + window.scrollY;
            const currRect = paragraphs[left].getBoundingClientRect();
            const currTop = currRect.top + window.scrollY;

            if (
                Math.abs(prevTop - viewportTop) <=
                Math.abs(currTop - viewportTop)
            ) {
                return paragraphs[left - 1].id;
            }
        }

        return paragraphs[left].id;
    }

    /**
     * Get the current reading position (in-memory, loaded from IDB at startup).
     * @returns {number|null}
     */
    function loadPosition() {
        return savedPosition;
    }

    /**
     * Save the current reading position to IDB.
     * Pure function: only persists position, does not update any UI state.
     * @returns {number|null} The saved paragraph number, or null if none found
     */
    function savePosition() {
        const paragraphId = getCurrentVisibleParagraphId();
        if (!paragraphId || !paragraphId.startsWith("p")) {
            return null;
        }
        const num = parseInt(paragraphId.substring(1), 10);
        if (!Number.isFinite(num) || num < 0) {
            return null;
        }
        savedPosition = num;
        fb2Reader.saveProgress(meta.book_id, num).catch(() => {});
        return num;
    }

    /**
     * Find which chapter contains a given paragraph number.
     * Uses meta.section_ranges to determine chapter boundaries.
     * @param {number} paragraphNum The paragraph number
     * @returns {number} The chapter index or -1 if not found
     */
    function getChapterIndexForParagraph(paragraphNum) {
        for (let i = 0; i < meta.section_ranges.length; i++) {
            const range = meta.section_ranges[i];
            if (
                range &&
                paragraphNum >= range.start &&
                paragraphNum <= range.end
            ) {
                return i;
            }
        }
        return -1;
    }

    let sectionPageCache = {
        key: null,
        pages: [],
    };

    /**
     * Batch-compute the start page for every section — one scroll reset, one reflow.
     */
    function getSectionStartPages() {
        const key = getPaginationCacheKey();
        if (sectionPageCache.key === key) {
            return sectionPageCache.pages;
        }

        const { total, cssStep } = getPaginationMetrics();
        if (total <= 0 || cssStep <= 0) {
            const zeros = meta.section_ids.map(() => 0);
            sectionPageCache = { key, pages: zeros };
            return zeros;
        }

        const pages = withScrollReset(({ contentRect, paddingLeft }) =>
            meta.section_ids.map((id) => {
                const el = document.getElementById(id);
                if (!el) {
                    return 0;
                }
                const scrollX = Math.max(
                    0,
                    el.getBoundingClientRect().left -
                        contentRect.left -
                        paddingLeft,
                );
                return scrollXToPage(scrollX);
            }),
        );

        sectionPageCache = { key, pages };
        return pages;
    }

    /**
     * Find the current chapter for page mode.
     * If one or more sections start on the current page, use the last one on that page.
     * Otherwise use the last section that started before the current page.
     * @returns {number} The chapter index or -1 if not found
     */
    function getCurrentChapterIndex() {
        if (currentSettings.readingMode === "chapter") {
            return currentChapterIndex;
        }
        if (currentSettings.readingMode !== "page") {
            const paragraphNum = loadPosition();
            return paragraphNum !== null
                ? getChapterIndexForParagraph(paragraphNum)
                : -1;
        }

        const sectionPages = getSectionStartPages();
        let result = -1;

        for (let i = 0; i < sectionPages.length; i++) {
            const page = sectionPages[i];
            if (page > currentPage) {
                break;
            }
            result = i;
        }

        return result;
    }

    /**
     * Highlight the current chapter in the TOC.
     * Removes highlight from all items and adds it to the current one.
     */
    function highlightCurrentChapterInTOC() {
        // Remove all current highlights
        const allLinks = tocList.querySelectorAll("a.toc-current");
        allLinks.forEach((a) => a.classList.remove("toc-current"));

        // Add highlight to current chapter
        if (currentChapterIndex >= 0) {
            const sectionId = checkedGet(
                meta.section_ids,
                currentChapterIndex,
                "current chapter section ID",
            );
            const link = tocList.querySelector(
                `a[data-section-id="${sectionId}"]`,
            );
            if (link) {
                link.classList.add("toc-current");
            }
        }
    }

    /**
     * Scroll the TOC panel to show the current chapter in the center.
     */
    function scrollTOCToCurrentChapter() {
        if (currentChapterIndex < 0) {
            return;
        }

        const sectionId = checkedGet(
            meta.section_ids,
            currentChapterIndex,
            "current chapter section ID",
        );
        const link = tocList.querySelector(`a[data-section-id="${sectionId}"]`);
        if (!link) {
            return;
        }

        // Scroll the TOC body so the link is centered
        const linkRect = link.getBoundingClientRect();
        const bodyRect = tocBody.getBoundingClientRect();
        const linkCenter = link.offsetTop + linkRect.height / 2;
        const bodyCenter = bodyRect.height / 2;
        tocBody.scrollTop = linkCenter - bodyCenter;
    }

    /**
     * Build a map from section_id to title text.
     * @returns {Object.<string, string>} Map of section_id -> title string
     */
    function buildTocTitleMap() {
        const titleMap = {};

        /**
         * @param {TocNode[]} nodes
         */
        function walk(nodes) {
            for (const node of nodes) {
                if (node.title && node.title.paragraphs) {
                    titleMap[node.id] = node.title.paragraphs.join(" — ");
                }
                if (node.children && node.children.length > 0) {
                    walk(node.children);
                }
            }
        }
        walk(meta.toc);
        return titleMap;
    }

    /**
     * Get the title of a chapter by its index.
     * @param {number} chapterIndex The chapter index
     * @returns {string} The chapter title or a default
     */
    function getChapterTitle(chapterIndex) {
        if (chapterIndex < 0) {
            return "";
        }
        const sectionId = checkedGet(
            meta.section_ids,
            chapterIndex,
            "chapter section ID",
        );
        const title = checkedGet(tocTitleMap, sectionId, "chapter title");
        return title;
    }

    /**
     * Update the progress footer with current chapter and progress info.
     * Pure rendering function - takes all data as parameters.
     * @param {number} paragraphNum - Current paragraph number (for scroll %)
     * @param {number} chapterIdx - Current chapter index (for title)
     */
    function updateProgressFooter(paragraphNum, chapterIdx) {
        progressChapter.textContent = getChapterTitle(chapterIdx);

        const percent =
            totalParagraphs > 0
                ? Math.round((paragraphNum / totalParagraphs) * 100)
                : 0;

        if (currentSettings.readingMode === "page") {
            const total = getTotalPages() + 1;
            progressValue.innerHTML = `${currentPage + 1} из ${total}&nbsp;&nbsp;(${percent}%)`;
        } else if (currentSettings.readingMode === "chapter") {
            const total = meta.section_ids.length;
            const current = Math.max(0, chapterIdx) + 1;
            progressValue.innerHTML = `${current} из ${total}&nbsp;&nbsp;(${percent}%)`;
        } else {
            progressValue.textContent = `${percent}%`;
        }
    }

    /**
     * Refresh all UI from a paragraph number.
     * Computes derived values (chapter) and updates DOM.
     * Only mutates currentChapterIndex for TOC highlight diffing.
     * @param {number|null} [paragraphNum] - The paragraph number to sync from. If omitted, reads from savedPosition.
     */
    function refreshUi(paragraphNum) {
        const num = paragraphNum ?? loadPosition() ?? 0;

        // Compute derived values (pure)
        const chapterIdx =
            currentSettings.readingMode === "page"
                ? getCurrentChapterIndex()
                : currentSettings.readingMode === "chapter"
                  ? currentChapterIndex
                  : num > 0
                    ? getChapterIndexForParagraph(num)
                    : -1;

        // Update TOC highlight (only mutates currentChapterIndex for diffing)
        if (chapterIdx !== currentChapterIndex) {
            currentChapterIndex = chapterIdx;
            highlightCurrentChapterInTOC();
        }

        // Update UI chrome
        if (currentSettings.readingMode === "page") {
            updateNavButtonsState();
        }
        updateProgressFooter(num, chapterIdx);
    }

    /**
     * Open the note modal and display the provided HTML content.
     * @param {string} html HTML content of the note
     */
    function openNoteModal(html) {
        modalBody.innerHTML = html;
        modal.classList.add("open");
        modal.setAttribute("aria-hidden", "false");
    }

    /**
     * Close the note modal and clear its contents.
     */
    function closeNoteModal() {
        modal.classList.remove("open");
        modal.setAttribute("aria-hidden", "true");
        modalBody.innerHTML = "";
    }

    // Attach handlers for closing the modal via the close button or by clicking
    // outside the modal content.
    modalClose.addEventListener("click", () => {
        closeNoteModal();
    });
    modal.addEventListener("click", (e) => {
        if (e.target === modal) {
            closeNoteModal();
        }
    });

    /**
     * Save the current settings to localStorage.  Called whenever a
     * preference is changed.
     */
    function saveSettings() {
        // Persist current settings to localStorage. Errors (e.g. quota exceeded) will propagate.
        localStorage.setItem(
            "fb2ReaderSettings",
            JSON.stringify(currentSettings),
        );
    }

    /**
     * Update the selected state for option buttons within a group.  It
     * removes the `selected` class from all buttons sharing the same
     * `data-setting` value, and adds it to the button whose
     * `data-value` matches the provided value.  This visual feedback
     * helps the user see which option is currently active.
     *
     * @param {string} setting The setting name (theme, font, line-height, alignment)
     * @param {string} value   The value that should be marked as selected
     */
    function updateSelectedButtons(setting, value) {
        const buttons = document.querySelectorAll(
            `.option-button[data-setting="${setting}"]`,
        );
        buttons.forEach((btn) => {
            if (btn.dataset.value === value) {
                btn.classList.add("selected");
            } else {
                btn.classList.remove("selected");
            }
        });
    }

    /**
     * Resolve "auto" to the concrete theme based on prefers-color-scheme.
     * @param {string} value
     * @returns {string}
     */
    function resolveTheme(value) {
        if (value === "auto") {
            return window.matchMedia("(prefers-color-scheme: dark)").matches
                ? "dark"
                : "light";
        }
        return value;
    }

    /**
     * Apply a theme by updating the theme class on the book container.
     *
     * @param {string} value The name of the theme to activate (auto, light, parchment, gray, dark)
     */
    function setTheme(value, persist = true) {
        const themes = ["light", "parchment", "gray", "dark"];
        themes.forEach((theme) => {
            document.documentElement.classList.remove(`theme-${theme}`);
        });
        const resolved = resolveTheme(value);
        document.documentElement.classList.add(`theme-${resolved}`);
        currentSettings.theme = value;
        updateSelectedButtons("theme", value);
        if (persist) {
            saveSettings();
        }
        // Theme changes only affect colours, not geometry — no layout recalc needed.
    }

    // Re-apply theme when device colour scheme changes (relevant when theme is "auto").
    window
        .matchMedia("(prefers-color-scheme: dark)")
        .addEventListener("change", () => {
            if (currentSettings.theme === "auto") {
                setTheme("auto", false);
            }
        });

    /**
     * Apply a font by updating the font class on the book container.
     *
     * @param {string} value The name of the font to activate (cactus, spectral, inter, roboto-mono)
     */
    function setFont(value, recalcLayout = true, persist = true) {
        const fonts = ["cactus", "spectral", "inter", "roboto-mono"];
        fonts.forEach((font) => container.classList.remove(`font-${font}`));
        container.classList.add(`font-${value}`);
        currentSettings.font = value;
        updateSelectedButtons("font", value);
        if (persist) {
            saveSettings();
        }
        if (recalcLayout) {
            // Recalculate pagination after layout change (coalesced)
            requestLayoutRecalc();
        }
    }

    /**
     * Apply text alignment by updating the alignment class on the book container.
     *
     * @param {string} value The alignment to activate (left, justify)
     */
    function setAlignment(value, recalcLayout = true, persist = true) {
        const alignments = ["left", "justify"];
        alignments.forEach((al) => container.classList.remove(`align-${al}`));
        container.classList.add(`align-${value}`);
        currentSettings.alignment = value;
        updateSelectedButtons("alignment", value);
        if (persist) {
            saveSettings();
        }
        if (recalcLayout) {
            // Recalculate pagination after layout change (coalesced)
            requestLayoutRecalc();
        }
    }

    /**
     * Apply line height by updating the line-height class on the book container.
     *
     * @param {string} value The line height setting (compact, normal, loose)
     */
    function setLineHeight(value, recalcLayout = true, persist = true) {
        const heights = ["compact", "normal", "loose"];
        heights.forEach((h) => container.classList.remove(`line-height-${h}`));
        container.classList.add(`line-height-${value}`);
        currentSettings.lineHeight = value;
        updateSelectedButtons("line-height", value);
        if (persist) {
            saveSettings();
        }
        if (recalcLayout) {
            // Recalculate pagination after layout change (coalesced)
            requestLayoutRecalc();
        }
    }

    /**
     * Apply automatic hyphenation by updating the hyphenation class on the book container.
     *
     * @param {string} value The hyphenation setting ("no" or "yes")
     */
    function setHyphenation(value, recalcLayout = true, persist = true) {
        const modes = ["no", "yes"];
        modes.forEach((mode) =>
            container.classList.remove(`hyphenation-${mode}`),
        );
        container.classList.add(`hyphenation-${value}`);
        currentSettings.hyphenation = value;
        updateSelectedButtons("hyphenation", value);
        if (persist) {
            saveSettings();
        }
        if (recalcLayout) {
            requestLayoutRecalc();
        }
    }

    const FONT_SIZE_MIN_PX = 14;
    const FONT_SIZE_MAX_PX = 34;
    const FONT_SIZE_STEP_PX = 2;

    function normalizeFontSize(value) {
        let px = Number(value);
        if (!Number.isFinite(px)) {
            px = defaults.fontSize;
        }

        px = Math.max(FONT_SIZE_MIN_PX, Math.min(FONT_SIZE_MAX_PX, px));
        px = Math.round(px / FONT_SIZE_STEP_PX) * FONT_SIZE_STEP_PX;
        px = Math.max(FONT_SIZE_MIN_PX, Math.min(FONT_SIZE_MAX_PX, px));

        return px;
    }

    /**
     * Apply the font size by setting a CSS variable on the container.
     * The size is expected to be in pixels (e.g. 18).
     * Bounded between 14px and 24px.
     *
     * @param {number} px The new font size in pixels
     */
    function setFontSize(px, recalcLayout = true, persist = true) {
        const normalizedPx = normalizeFontSize(px);
        currentSettings.fontSize = normalizedPx;

        const sizeValue = normalizedPx + "px";
        container.style.setProperty("--font-size", sizeValue);

        fontSizeDisplay.textContent = sizeValue;
        fontSizeDisplay.style.fontSize = sizeValue;
        fontSizeDecrease.disabled = normalizedPx <= FONT_SIZE_MIN_PX;
        fontSizeIncrease.disabled = normalizedPx >= FONT_SIZE_MAX_PX;

        if (persist) {
            saveSettings();
        }
        if (recalcLayout) {
            // Recalculate pagination after layout change (coalesced)
            requestLayoutRecalc();
        }
    }

    // =========================================================================
    // Pagination mode state and logic
    // =========================================================================

    // Cache pagination metrics to avoid repeated expensive measurements.
    // Keyed by layout-dependent values (widths + relevant computed styles).
    let paginationCache = {
        key: null,
        total: 0, // 0-indexed maximum page
        cssStep: 0,
        actualMaxScroll: 0,
    };

    // =========================================================================
    // Baseline grid snapping (images only)
    //
    // In page mode CSS multi-column layout flows content sequentially.  If an
    // image has a total height (content + margins) that is not a multiple of
    // the line-height, subsequent text baselines in the two columns diverge.
    //
    // Headings, spacers and other block elements are already grid-aligned via
    // CSS (compensated line-height, explicit height: var(--lh), etc.).  Only
    // images have truly arbitrary pixel heights, so we snap those with JS.
    // =========================================================================

    /**
     * Compute the current base line-height in pixels.
     * Caches the result until invalidated by requestLayoutRecalc.
     * @returns {number} Line height in pixels
     */
    let cachedLineHeight = 0;
    function getBaseLineHeight() {
        if (cachedLineHeight > 0) {
            return cachedLineHeight;
        }
        // getComputedStyle returns line-height in px (even for "normal")
        // and reuses an already-computed layout — no DOM insertion needed.
        const lhPx = parseFloat(
            window.getComputedStyle(bookContent).lineHeight,
        );
        if (lhPx > 0) {
            cachedLineHeight = lhPx;
            return cachedLineHeight;
        }
        // Fallback: DOM probe (should not normally be reached).
        const probe = document.createElement("span");
        probe.textContent = "\u00a0";
        probe.style.visibility = "hidden";
        probe.style.position = "absolute";
        probe.style.whiteSpace = "nowrap";
        bookContent.appendChild(probe);
        cachedLineHeight = probe.getBoundingClientRect().height;
        probe.remove();
        return cachedLineHeight;
    }

    function getAvailableColumnHeightPx() {
        const ls = getLayoutStyles();
        const columnHeight =
            bookContent.clientHeight - ls.paddingTop - ls.paddingBottom;
        return Math.max(0, columnHeight);
    }

    /**
     * Single-pass update for all .img-wrap elements.
     *
     * In every mode: sets max-height on images so they scale down to
     * fit the content width (aspect-ratio-aware).
     * In page mode: additionally caps to column height and snaps each
     * wrapper to the baseline grid (padding-bottom).
     *
     * Baseline snapping is asynchronous (next frame) to avoid a
     * synchronous forced reflow.  The optional onDone callback is
     * invoked after snapping actually modifies the DOM, so callers
     * that need to measure layout (e.g. getPageForElement for position
     * restore) see the final geometry.  Scroll mode and zero-snapping
     * cases invoke onDone synchronously.
     *
     * @param {() => void} [onDone] Called after the DOM is in its
     *        final state for this refresh.
     */
    function refreshImageLayout(onDone) {
        const wraps = bookContent.querySelectorAll(".img-wrap");
        const isPageMode = currentSettings.readingMode === "page";
        const ls = getLayoutStyles();
        const contentWidth =
            bookContent.clientWidth - ls.paddingLeft - ls.paddingRight;
        const columnHeight = isPageMode ? getAvailableColumnHeightPx() : 0;

        // Pre-compute line height before any DOM writes to avoid an extra
        // forced reflow when the probe element invalidates layout.
        const lh = isPageMode ? getBaseLineHeight() : 0;

        // Write 1 — set image max-height + reset old snapping.
        wraps.forEach((wrap) => {
            const img = wrap.querySelector("img");
            if (!img) {
                return;
            }

            // Use naturalWidth/Height when available, fall back to HTML attrs
            const nw =
                img.naturalWidth || parseFloat(img.getAttribute("width")) || 0;
            const nh =
                img.naturalHeight ||
                parseFloat(img.getAttribute("height")) ||
                0;

            let maxH = "";
            if (nw > 0 && nh > 0 && contentWidth > 0) {
                let scaled = (contentWidth * nh) / nw;
                if (isPageMode && columnHeight > 0) {
                    scaled = Math.min(scaled, columnHeight - 1);
                }
                maxH = Math.max(0, Math.floor(scaled)) + "px";
            }

            if (img.style.maxHeight !== maxH) {
                img.style.maxHeight = maxH;

                // Image size changed — clear stale baseline snapping so
                // it gets recomputed in the read pass below.
                if (wrap.dataset.baselineSnapped) {
                    wrap.style.paddingBottom = "";
                    delete wrap.dataset.baselineSnapped;
                }
            } else if (!isPageMode && wrap.dataset.baselineSnapped) {
                // Switching to scroll mode — remove leftover page-mode snapping.
                wrap.style.paddingBottom = "";
                delete wrap.dataset.baselineSnapped;
            }
        });

        // Baseline grid snapping only in page mode
        if (!isPageMode || lh <= 0 || columnHeight <= 0) {
            if (onDone) {
                onDone();
            }
            return;
        }

        // Defer baseline snapping to avoid a synchronous forced reflow
        // (~50-150ms on mobile).  The content is shown immediately with
        // correct image sizes; grid snapping happens in the next frame.
        requestAnimationFrame(() => {
            // Read pass — batch-read all measurements.
            // In page mode .img-wrap has margin:0, so we use
            // getBoundingClientRect().height directly (no getComputedStyle).
            const adjustments = [];
            wraps.forEach((wrap) => {
                const outerHeight = wrap.getBoundingClientRect().height;
                if (outerHeight <= 0) {
                    return;
                }

                const remainder = outerHeight % lh;
                if (remainder < 0.01 || lh - remainder < 0.01) {
                    return;
                }

                const desiredDelta = lh - remainder;
                const delta = Math.min(
                    desiredDelta,
                    Math.max(0, columnHeight - outerHeight),
                );
                if (delta < 0.5) {
                    return;
                }
                adjustments.push({ wrap, delta });
            });

            // Write — apply snapping.
            for (const { wrap, delta } of adjustments) {
                wrap.style.paddingBottom = delta + "px";
                wrap.dataset.baselineSnapped = "1";
            }

            if (onDone) {
                onDone();
            }
        });
    }

    // Debounced pagination recomputation. Used by settings changes and resize signals.
    // Coalesces multiple calls into a single recompute on the next animation frame.

    /**
     * Sync --viewport-offset CSS variable with the actual visual viewport.
     * When the mobile URL bar is visible, 100dvh can exceed the visible area.
     * We compensate with extra bottom padding so column content stays visible.
     * Called on mode switch and viewport resize; no-op without visualViewport.
     *
     * Optimisations:
     * - Skips entirely in scroll mode (CSS doesn't consume the variable).
     * - Skips the CSS write when the value hasn't changed, avoiding an
     *   extra forced reflow in the subsequent refreshImageLayout() call.
     */
    let lastViewportOffset = -1;
    function syncViewportOffset() {
        if (!window.visualViewport) {
            return;
        }
        if (currentSettings.readingMode !== "page") {
            return;
        }
        const offset = Math.max(
            0,
            container.clientHeight - window.visualViewport.height,
        );
        if (Math.abs(offset - lastViewportOffset) < 0.5) {
            return;
        }
        lastViewportOffset = offset;
        document.documentElement.style.setProperty(
            "--viewport-offset",
            offset + "px",
        );
    }

    // Cache layout dimensions that don't change between layout recalcs.
    // Reading clientWidth / scrollWidth / getBoundingClientRect after a
    // scrollLeft or transform change forces an expensive reflow (~10ms on
    // mobile).  We snapshot these once and reuse until requestLayoutRecalc
    // invalidates them.
    let cachedDimensions = null;
    let cachedNavZoneWidth = 0;
    let cachedLayoutRect = null;

    /**
     * Drop all layout-dependent caches so the next measurement reads fresh
     * values from the DOM.  Called whenever layout may have changed
     * (resize, settings change, mode switch, fullscreen).
     *
     * Note: paginationCache is not cleared here.  Its key depends on the
     * cleared dimensions, so it self-invalidates on the next
     * getPaginationMetrics() call.
     */
    function invalidateLayoutCaches() {
        cachedLineHeight = 0;
        cachedLayoutStyles = null;
        cachedLayoutRect = null;
        cachedDimensions = null;
        cachedNavZoneWidth = 0;
    }

    function finishLayoutRefresh(onDone) {
        syncViewportOffset();
        refreshImageLayout(() => {
            if (currentSettings.readingMode === "page") {
                // Baseline snapping mutated .img-wrap paddingBottom,
                // which changes scrollWidth and therefore cssStep/total.
                // Drop dimension and layout-rect caches so getPageForElement
                // measures against the final geometry, not stale values
                // from before snapping.
                cachedDimensions = null;
                cachedLayoutRect = null;
                paginationCache.key = null;
            }

            restorePositionAndRefreshUi(false);

            if (onDone) {
                onDone();
            }
        });
    }

    /**
     * Schedule a layout recalculation.
     *
     * Scroll mode runs synchronously.  Page mode uses a 50ms debounce
     * (to let resize bursts settle) followed by a double-rAF: the 1st
     * frame lets the browser apply CSS changes (e.g. hyphens toggle),
     * the 2nd runs the heavy JS pagination work.
     *
     * The refresh always jumps to savedPosition (via finishLayoutRefresh
     * → restorePositionAndRefreshUi).  Proportional pro-rating of
     * currentPage is not used because it is inaccurate across chapter
     * boundaries where column-break rules give pages unequal weight.
     *
     * Coalescing: if a request is already pending, this call cancels it
     * and schedules a new one.  The 50ms debounce guarantees any pending
     * savePositionRaf (~16ms) runs first, so savedPosition is current
     * even if the user resizes immediately after a page turn.
     */
    function requestLayoutRecalc() {
        invalidateLayoutCaches();
        cancelPendingRecalc();

        if (currentSettings.readingMode !== "page") {
            finishLayoutRefresh();
            return;
        }

        recalcPending = { timeoutId: 0, rafId: 0 };
        const entry = recalcPending;
        entry.timeoutId = setTimeout(() => {
            entry.timeoutId = 0;
            entry.rafId = requestAnimationFrame(() => {
                entry.rafId = requestAnimationFrame(() => {
                    entry.rafId = 0;
                    if (recalcPending !== entry) {
                        return;
                    }
                    recalcPending = null;
                    finishLayoutRefresh();
                });
            });
        }, 50);
    }

    /**
     * Restore reading position and refresh UI.
     * @param {boolean} [closeUi=false] - Whether to close panels after navigation
     */
    function restorePositionAndRefreshUi(closeUi = false) {
        const paragraphNum = loadPosition();

        if (paragraphNum !== null) {
            navigateToElement(`p${paragraphNum}`, closeUi, true);
            // In page mode, navigateToElement -> goToPage -> refreshUi
            if (currentSettings.readingMode !== "page") {
                refreshUi(paragraphNum);
            }
        } else if (currentSettings.readingMode === "page") {
            goToPage(0, true);
        } else {
            if (currentSettings.readingMode === "chapter") {
                showChapter(0);
            }
            refreshUi(null);
        }
    }

    function getDimensions() {
        if (cachedDimensions) {
            return cachedDimensions;
        }
        cachedDimensions = {
            clientWidth: bookContent.clientWidth,
            scrollWidth: bookContent.scrollWidth,
            boundingWidth: bookContent.getBoundingClientRect().width,
        };
        return cachedDimensions;
    }

    function getPaginationCacheKey() {
        const ls = getLayoutStyles();
        const d = getDimensions();
        const key = [
            currentSettings.readingMode,
            d.clientWidth,
            d.boundingWidth,
            d.scrollWidth,
            ls.paddingLeft,
            ls.paddingRight,
            ls.columnGap,
        ].join("|");
        return key;
    }

    function computeCssStep() {
        const ls = getLayoutStyles();
        const rectWidth = getDimensions().boundingWidth;
        const contentWidth = rectWidth - ls.paddingLeft - ls.paddingRight;
        if (contentWidth <= 0) {
            return 0;
        }
        return contentWidth + ls.columnGap;
    }

    /**
     * Compute pagination metrics in O(1) using pure math.
     * CSS multi-column layout uses uniform column widths, so page
     * positions are evenly spaced at cssStep intervals.
     * No scrollLeft probing needed.
     */
    function computePaginationMetrics() {
        const empty = { total: 0, cssStep: 0, actualMaxScroll: 0 };
        if (currentSettings.readingMode !== "page") {
            return empty;
        }

        const d = getDimensions();
        const viewportWidth = d.clientWidth;
        if (viewportWidth <= 0) {
            return empty;
        }

        const maxScroll = d.scrollWidth - viewportWidth;
        if (maxScroll <= 0) {
            return empty;
        }

        const cssStep = computeCssStep();
        if (cssStep <= 0) {
            return empty;
        }

        const actualMaxScroll = Math.max(0, maxScroll);
        // Math.round handles the common case well, but in 2-column layout
        // with an odd number of columns the ratio lands at ≈ N+0.5.
        // Integer rounding of scrollWidth/clientWidth (±2px) can nudge it
        // just below X.5, making round() discard a real half-filled page.
        //
        // Fix: after round(), check whether significant scroll range extends
        // past the computed last page.  A real column adds at least
        // cssStep/3 of scroll range; integer noise is ≤ ~2px — so
        // cssStep/4 cleanly separates the two.
        let total = Math.max(0, Math.round(actualMaxScroll / cssStep));
        if (actualMaxScroll - total * cssStep > cssStep / 4) {
            total += 1;
        }

        return { total, cssStep, actualMaxScroll };
    }

    function getPaginationMetrics() {
        const key = getPaginationCacheKey();
        if (paginationCache.key === key) {
            return paginationCache;
        }
        const metrics = computePaginationMetrics();
        paginationCache = { key, ...metrics };
        return paginationCache;
    }

    /**
     * Get the total number of pages in pagination mode.
     * @returns {number} Total page count (0-indexed maximum page)
     */
    function getTotalPages() {
        const total = getPaginationMetrics().total || 0;
        return total;
    }

    /**
     * Calculate the scroll position for a given page.  O(1) — pure math.
     * @param {number} page The page index (0-based)
     * @returns {number} The scrollLeft value for this page
     */
    function getScrollPositionForPage(page) {
        const { total, cssStep, actualMaxScroll } = getPaginationMetrics();
        if (total <= 0 || page <= 0) {
            return 0;
        }
        if (page >= total) {
            return actualMaxScroll;
        }
        return page * cssStep;
    }

    /**
     * Scroll bookContent to the given page.
     *
     * In multi-column layout with an odd number of total columns, the
     * browser's maximum scrollLeft (= scrollWidth − clientWidth) lands
     * halfway between two page boundaries.  The viewport then shows
     * the previous page's right column blended with the last column.
     *
     * Fix: scroll as far as the browser allows (actualMaxScroll) and
     * apply a CSS translateX to shift the remaining distance so the
     * last page's columns are properly aligned.
     */
    function scrollToPage(page) {
        const { total, cssStep, actualMaxScroll } = getPaginationMetrics();
        if (total <= 0 || page <= 0) {
            bookContent.scrollLeft = 0;
            bookContent.style.transform = "";
            return;
        }
        if (page >= total) {
            const ideal = total * cssStep;
            bookContent.scrollLeft = actualMaxScroll;
            const drift = ideal - actualMaxScroll;
            // Apply transform only when drift is a real half-page gap
            // (odd column count), not just integer-rounding noise (≤ ~2px).
            bookContent.style.transform =
                drift > cssStep / 4 ? `translateX(${-drift}px)` : "";
            return;
        }
        bookContent.scrollLeft = page * cssStep;
        bookContent.style.transform = "";
    }

    /**
     * Navigate to a specific page (0-indexed).
     * @param {number} pageNum The page index to navigate to
     */
    let savePositionRaf = 0;
    function goToPage(pageNum, skipSave = false) {
        const total = getTotalPages();
        const clamped = Math.max(0, Math.min(pageNum, total));
        currentPage = clamped;
        scrollToPage(currentPage);
        if (!skipSave) {
            // Defer the expensive savePosition (which triggers forced reflow
            // via withScrollReset) to the next frame so page turns stay snappy.
            cancelAnimationFrame(savePositionRaf);
            savePositionRaf = requestAnimationFrame(() => {
                savePositionRaf = 0;
                refreshUi(savePosition());
            });
        }
        // Update UI immediately — chapter and progress will be corrected
        // in the rAF callback above (if save is not skipped).
        refreshUi();
    }

    /**
     * Navigate to the next page.
     */
    function goToNextPage() {
        goToPage(currentPage + 1);
    }

    /**
     * Navigate to the previous page.
     */
    function goToPrevPage() {
        goToPage(currentPage - 1);
    }

    // -----------------------------------------------------------------
    // Shared helpers for element → page resolution
    // -----------------------------------------------------------------

    /**
     * Run a callback with bookContent.scrollLeft temporarily set to 0.
     * Passes shared measurement context so callers don't duplicate setup.
     *
     * @template T
     * @param {(ctx: {contentRect: DOMRect, paddingLeft: number}) => T} fn
     * @returns {T}
     */
    function withScrollReset(fn) {
        const saved = bookContent.scrollLeft;
        bookContent.scrollLeft = 0;
        if (!cachedLayoutRect) {
            const contentRect = bookContent.getBoundingClientRect();
            const paddingLeft = getLayoutStyles().paddingLeft;
            cachedLayoutRect = { contentRect, paddingLeft };
        }
        try {
            return fn(cachedLayoutRect);
        } finally {
            bookContent.scrollLeft = saved;
        }
    }

    /**
     * Convert a scroll-space X offset to a clamped page index. O(1).
     *
     * Only used for element → page resolution (getPageForElement), NOT
     * for pagination counting (computePaginationMetrics) or scrolling
     * (scrollToPage / getScrollPositionForPage).  Changing the tolerance
     * here affects only which page a given paragraph lands on when
     * restoring position.
     *
     * Subpixel noise: cssStep and elRect.left are both floats computed
     * from getBoundingClientRect and getComputedStyle.  A paragraph that
     * begins exactly at page K can land at scrollX = K*cssStep - 0.3,
     * and plain floor() would round it down to K-1 ("book opens one page
     * before the saved paragraph").  A 2px tolerance absorbs this
     * without crossing into the next real page.
     * @param {number} scrollX
     * @returns {number}
     */
    const SCROLL_X_TO_PAGE_TOLERANCE = 2;
    function scrollXToPage(scrollX) {
        const { total, cssStep, actualMaxScroll } = getPaginationMetrics();
        if (total <= 0 || cssStep <= 0 || scrollX <= 0) {
            return 0;
        }
        if (scrollX >= actualMaxScroll) {
            return total;
        }
        return Math.max(
            0,
            Math.min(
                Math.floor((scrollX + SCROLL_X_TO_PAGE_TOLERANCE) / cssStep),
                total,
            ),
        );
    }

    /**
     * Find which page contains a given element by ID. O(1).
     * @param {string} elementId
     * @returns {number} page index (0-based) or 0 if not found
     */
    function getPageForElement(elementId) {
        if (currentSettings.readingMode !== "page") {
            return 0;
        }
        const el = document.getElementById(elementId);
        if (!el) {
            return 0;
        }
        const { total, cssStep } = getPaginationMetrics();
        if (total <= 0 || cssStep <= 0) {
            return 0;
        }

        return withScrollReset(({ contentRect, paddingLeft }) => {
            const elRect = el.getBoundingClientRect();
            const scrollX = Math.max(
                0,
                elRect.left - contentRect.left - paddingLeft,
            );
            return scrollXToPage(scrollX);
        });
    }

    /**
     * Navigate to a specific element by ID.
     * In scroll mode and chapter mode, uses scrollIntoView.
     * In page mode, calculates and navigates to the correct page.
     * @param {string} elementId The element ID to navigate to
     */
    function navigateToElement(elementId, closeUi = true, skipSave = false) {
        if (closeUi) {
            closePanels();
        }

        if (currentSettings.readingMode === "page") {
            const page = getPageForElement(elementId);
            goToPage(page, skipSave);
        } else {
            const element = document.getElementById(elementId);
            // In chapter mode: ensure the chapter containing the target
            // element is visible before scrolling to it.
            if (currentSettings.readingMode === "chapter" && element) {
                const section = element.closest("section[id]");
                if (section) {
                    const chapterIdx = meta.section_ids.indexOf(section.id);
                    if (chapterIdx >= 0) {
                        showChapter(chapterIdx);
                    }
                }
            }
            if (element) {
                withProgrammaticScroll(() =>
                    element.scrollIntoView({ behavior: "instant" }),
                );
            }
            if (!skipSave) {
                refreshUi(savePosition());
            }
        }
    }

    /**
     * Update the disabled state of navigation buttons based on current page.
     */
    function updateNavButtonsState() {
        const total = getTotalPages();

        if (currentPage <= 0) {
            pageNavPrev.classList.add("disabled");
        } else {
            pageNavPrev.classList.remove("disabled");
        }

        if (currentPage >= total) {
            pageNavNext.classList.add("disabled");
        } else {
            pageNavNext.classList.remove("disabled");
        }
    }

    /**
     * Apply column count preference.  On wide screens the user can choose
     * between 1 and 2 columns; on narrow screens the media query forces
     * single column regardless of this setting.
     *
     * @param {string} value  "1" or "2"
     */
    function setColumns(value, recalcLayout = true, persist = true) {
        if (value === "1") {
            container.classList.add("columns-1");
        } else {
            container.classList.remove("columns-1");
        }
        currentSettings.columns = value;
        updateSelectedButtons("columns", value);
        if (persist) {
            saveSettings();
        }
        if (recalcLayout) {
            requestLayoutRecalc();
        }
    }

    /**
     * Show or hide the columns option group depending on reading mode.
     * The setting only makes sense in page mode.
     */
    function updateColumnsGroupVisibility() {
        columnsGroup.style.display =
            currentSettings.readingMode === "page" ? "" : "none";
    }

    /**
     * Apply reading mode by updating classes on the container and body.
     * Navigates to the saved paragraph position when switching modes.
     *
     * @param {string} value The reading mode to activate ("scroll", "chapter", or "page")
     */
    function setReadingMode(value, restorePosition = true, persist = true) {
        const prevMode = currentSettings.readingMode;
        const modes = ["scroll", "chapter", "page"];
        modes.forEach((mode) => {
            container.classList.remove(`mode-${mode}`);
            document.body.classList.remove(`mode-${mode}`);
        });
        container.classList.add(`mode-${value}`);
        document.body.classList.add(`mode-${value}`);
        bookContent.style.transform = "";
        currentSettings.readingMode = value;
        updateSelectedButtons("reading-mode", value);
        updateColumnsGroupVisibility();
        if (persist) {
            saveSettings();
        }

        if (value !== "chapter" && prevMode === "chapter") {
            showAllChapters();
        }

        if (!restorePosition) {
            return;
        }

        lastViewportOffset = -1;

        // requestLayoutRecalc runs synchronously in scroll mode (no flash
        // of the book top) and through debounce + double-rAF in page mode.
        // A racing resize coalesces into the same refresh.
        requestLayoutRecalc();
    }

    // Toggle visibility of navigation buttons when user clicks on book text.
    let chromeVisible = true;
    // Suppress scroll-direction chrome changes during programmatic scrolls.
    let programmaticScroll = false;
    let lastScrollY = window.scrollY;

    /**
     * Run a scroll action with chrome auto-hide suppressed.
     * Sets the programmaticScroll flag, executes the callback,
     * then clears the flag after the scroll settles (rAF + 50ms).
     * @param {() => void} fn The scroll action to perform
     */
    function withProgrammaticScroll(fn) {
        programmaticScroll = true;
        lastScrollY = window.scrollY;
        fn();
        requestAnimationFrame(() => {
            setTimeout(() => {
                programmaticScroll = false;
                lastScrollY = window.scrollY;
            }, 50);
        });
    }

    // iPad Safari shows a "you are entering text in fullscreen mode" warning
    // on any tap inside Fullscreen API when a focusable element receives
    // focus.  Skip programmatic focus on touch-only devices: keyboard
    // shortcuts (Space scroll, etc.) aren't used there anyway.
    const isTouchOnly =
        matchMedia("(pointer: coarse)").matches &&
        !matchMedia("(pointer: fine)").matches;
    function focusBookContent() {
        if (isTouchOnly) {
            return;
        }
        bookContent.focus({ preventScroll: true });
    }

    function setChromeVisible(visible) {
        chromeVisible = visible;
        document.body.classList.toggle("chrome-hidden", !visible);

        // These buttons become invisible; also make them non-interactive.
        // (Prevents accidental clicks on invisible controls.)
        settingsToggle.disabled = !visible;
        tocToggle.disabled = !visible;

        if (!fullscreenToggle.hidden) {
            fullscreenToggle.disabled = !visible;
        }

        // Reduce chance of focus landing on hidden controls.
        settingsToggle.tabIndex = visible ? 0 : -1;
        tocToggle.tabIndex = visible ? 0 : -1;

        // If one of these controls has focus, move focus away before hiding.
        if (
            !visible &&
            document.activeElement &&
            (document.activeElement === settingsToggle ||
                document.activeElement === tocToggle ||
                document.activeElement === fullscreenToggle)
        ) {
            focusBookContent();
        }
    }

    // =========================================================================
    // Touch/swipe handling for mobile pagination
    // =========================================================================

    const UI_SELECTOR =
        "a, button, [role='button'], #settings-panel, #toc-panel, #note-modal, #overlay, #reader-header";

    let touchStartX = 0;
    let touchStartY = 0;
    const SWIPE_THRESHOLD = 50; // minimum swipe distance in pixels

    /**
     * Whether a touch event targets UI that should block swipe navigation.
     * @param {TouchEvent} e
     * @returns {boolean}
     */
    function isUiOverlay(e) {
        return e.target.closest(UI_SELECTOR);
    }

    document.addEventListener(
        "touchstart",
        (e) => {
            if (currentSettings.readingMode !== "page") {
                return;
            }
            if (isUiOverlay(e)) {
                return;
            }
            touchStartX = e.touches[0].clientX;
            touchStartY = e.touches[0].clientY;
        },
        { passive: true },
    );

    document.addEventListener(
        "touchend",
        (e) => {
            if (currentSettings.readingMode !== "page") {
                return;
            }
            if (isUiOverlay(e)) {
                return;
            }
            const touchEndX = e.changedTouches[0].clientX;
            const touchEndY = e.changedTouches[0].clientY;
            const deltaX = touchEndX - touchStartX;
            const deltaY = touchEndY - touchStartY;

            // Only trigger swipe if horizontal movement is greater than vertical
            if (
                Math.abs(deltaX) > Math.abs(deltaY) &&
                Math.abs(deltaX) > SWIPE_THRESHOLD
            ) {
                setChromeVisible(false);
                if (deltaX > 0) {
                    goToPrevPage();
                } else {
                    goToNextPage();
                }
            }
        },
        { passive: true },
    );

    // =========================================================================
    // Page navigation via click/tap zones and chrome toggle
    // =========================================================================

    /**
     * Get the width of the click/tap navigation zone (one side).
     * On desktop it matches the page-nav arrow strip; on mobile it's 1/4 viewport.
     */
    function getNavZoneWidth() {
        if (cachedNavZoneWidth > 0) {
            return cachedNavZoneWidth;
        }
        cachedNavZoneWidth =
            pageNavPrev.offsetWidth ||
            pageNavNext.offsetWidth ||
            window.innerWidth / 4;
        return cachedNavZoneWidth;
    }

    // Prevent browser text-selection when rapidly clicking in a nav zone.
    // The middle zone is left alone so double-click text selection still works.
    document.addEventListener("mousedown", (e) => {
        if (currentSettings.readingMode !== "page") {
            return;
        }
        if (e.target.closest(UI_SELECTOR)) {
            return;
        }
        const x = e.clientX;
        const w = window.innerWidth;
        const zone = getNavZoneWidth();
        if (x < zone || x > w - zone) {
            e.preventDefault();
        }
    });

    // Zone-based page navigation: left zone → prev, right zone → next.
    // Clicks on interactive elements are ignored.  Middle zone toggles chrome.
    document.addEventListener("click", (e) => {
        if (e.target.closest(UI_SELECTOR)) {
            return;
        }
        if (currentSettings.readingMode === "page") {
            const x = e.clientX;
            const w = window.innerWidth;
            const zone = getNavZoneWidth();
            if (x < zone) {
                setChromeVisible(false);
                goToPrevPage();
                return;
            }
            if (x > w - zone) {
                setChromeVisible(false);
                goToNextPage();
                return;
            }
        }
        // Skip chrome toggle on repeated clicks (double/triple) to avoid flicker.
        if (e.detail > 1) {
            return;
        }
        setChromeVisible(!chromeVisible);
    });

    // Desktop: arrow hints and pointer cursor when mouse is in nav strip.
    document.addEventListener("mousemove", (e) => {
        if (currentSettings.readingMode !== "page") {
            return;
        }
        const x = e.clientX;
        const w = window.innerWidth;
        const zone = getNavZoneWidth();
        const inPrev = x < zone && !pageNavPrev.classList.contains("disabled");
        const inNext =
            x > w - zone && !pageNavNext.classList.contains("disabled");
        pageNavPrev.classList.toggle("hovered", inPrev);
        pageNavNext.classList.toggle("hovered", inNext);
        document.body.style.cursor = inPrev || inNext ? "pointer" : "";
    });
    document.addEventListener("mouseleave", () => {
        pageNavPrev.classList.remove("hovered");
        pageNavNext.classList.remove("hovered");
        document.body.style.cursor = "";
    });

    /**
     * Build the table of contents (TOC).  Always uses meta.toc; no fallback.
     */
    function buildTOC() {
        tocList.innerHTML = "";

        // Always build the TOC from the metadata; there is no fallback.
        function buildFromNodes(nodes, parentList) {
            nodes.forEach((node) => {
                const li = document.createElement("li");
                const a = document.createElement("a");
                let text = "";
                if (node.title) {
                    text = node.title.paragraphs.join(" — ");
                }
                a.textContent = text || "…";
                a.href = "#" + node.id;
                a.setAttribute("data-section-id", node.id);
                a.addEventListener("click", (e) => {
                    e.preventDefault();
                    navigateToElement(node.id);
                });
                li.appendChild(a);
                if (Array.isArray(node.children) && node.children.length > 0) {
                    const childList = document.createElement("ul");
                    buildFromNodes(node.children, childList);
                    li.appendChild(childList);
                }
                parentList.appendChild(li);
            });
        }
        buildFromNodes(meta.toc, tocList);
    }

    /**
     * Open the settings panel and show the overlay.  The TOC panel is
     * closed if it is open.  This does not rebuild the TOC.
     */
    function openSettings() {
        settingsPanel.classList.add("open");
        overlay.classList.add("visible");
        settingsPanel.setAttribute("aria-hidden", "false");
        overlay.setAttribute("aria-hidden", "false");
        // Close TOC if open
        tocPanel.classList.remove("open");
        tocPanel.setAttribute("aria-hidden", "true");
        // Ensure chrome UI is visible when opening settings
        setChromeVisible(true);
    }

    /**
     * Close the settings panel and hide the overlay if no other panel is open.
     */
    function closeSettings() {
        settingsPanel.classList.remove("open");

        // Move focus to book content so native Space scrolling works.
        if (
            document.activeElement &&
            settingsPanel.contains(document.activeElement)
        ) {
            focusBookContent();
        }

        settingsPanel.setAttribute("aria-hidden", "true");
        if (!tocPanel.classList.contains("open")) {
            overlay.classList.remove("visible");
            overlay.setAttribute("aria-hidden", "true");
        }
    }

    /**
     * Open the table of contents panel and show the overlay.  The
     * settings panel is closed if it is open.  This does not rebuild the TOC.
     */
    function openToc() {
        tocPanel.classList.add("open");
        overlay.classList.add("visible");
        tocPanel.setAttribute("aria-hidden", "false");
        overlay.setAttribute("aria-hidden", "false");
        // Close settings if open
        settingsPanel.classList.remove("open");
        settingsPanel.setAttribute("aria-hidden", "true");
        // Ensure chrome UI is visible when opening TOC
        setChromeVisible(true);
        // Scroll to current chapter after panel is open
        requestAnimationFrame(() => scrollTOCToCurrentChapter());
    }

    /**
     * Close the table of contents panel and hide the overlay if no
     * other panel is open.
     */
    function closeToc() {
        tocPanel.classList.remove("open");

        // Move focus to book content so native Space scrolling works.
        if (
            document.activeElement &&
            tocPanel.contains(document.activeElement)
        ) {
            focusBookContent();
        }

        tocPanel.setAttribute("aria-hidden", "true");
        if (!settingsPanel.classList.contains("open")) {
            overlay.classList.remove("visible");
            overlay.setAttribute("aria-hidden", "true");
        }
    }

    /**
     * Close both settings and TOC panels.
     */
    function closePanels() {
        settingsPanel.classList.remove("open");
        tocPanel.classList.remove("open");

        settingsPanel.setAttribute("aria-hidden", "true");
        tocPanel.setAttribute("aria-hidden", "true");
        overlay.classList.remove("visible");
        overlay.setAttribute("aria-hidden", "true");

        // Always move focus to book content so native Space scrolling
        // and keyboard shortcuts work immediately.
        focusBookContent();
    }

    // Assign event listeners to toggles, close buttons and overlay
    settingsToggle.addEventListener("click", () => {
        // Toggle settings panel
        if (settingsPanel.classList.contains("open")) {
            closeSettings();
        } else {
            openSettings();
        }
    });
    settingsClose.addEventListener("click", () => {
        closeSettings();
    });
    tocToggle.addEventListener("click", () => {
        if (tocPanel.classList.contains("open")) {
            closeToc();
        } else {
            openToc();
        }
    });
    tocClose.addEventListener("click", () => {
        closeToc();
    });
    overlay.addEventListener("click", () => {
        closePanels();
    });

    const noteRefs = bookContent.querySelectorAll("a.note__ref[data-note-id]");
    noteRefs.forEach((noteRef) => {
        // Keep status bar clean while preserving keyboard accessibility.
        noteRef.removeAttribute("href");
        noteRef.style.cursor = "pointer";
    });

    const noteHtmlMap = new Map();
    for (const note of meta.notes) {
        noteHtmlMap.set(note.id, note.html);
    }

    function flashNoteRef(refId) {
        const noteRef = document.getElementById(refId);
        if (!(noteRef instanceof HTMLElement)) {
            return;
        }
        noteRef.classList.remove("note__ref--flash");
        void noteRef.offsetWidth;
        noteRef.classList.add("note__ref--flash");
        noteRef.addEventListener(
            "animationend",
            () => {
                noteRef.classList.remove("note__ref--flash");
            },
            { once: true },
        );
    }

    bookContent.addEventListener("click", (e) => {
        const noteRef = e.target.closest("a.note__ref[data-note-id]");
        if (noteRef) {
            e.preventDefault();
            const noteId = noteRef.getAttribute("data-note-id");
            const html = noteHtmlMap.get(noteId);
            if (html) {
                openNoteModal(html);
            }
            return;
        }

        const backref = e.target.closest("a.note__backref");
        if (backref) {
            e.preventDefault();
            const href = backref.getAttribute("href");
            if (href && href.startsWith("#")) {
                const targetId = href.substring(1);
                navigateToElement(targetId);
                requestAnimationFrame(() => {
                    requestAnimationFrame(() => {
                        flashNoteRef(targetId);
                    });
                });
            }
        }
    });

    // Assign event listeners to option buttons.  Each button defines its
    // setting and value via data attributes.  The appropriate setter
    // function is called based on the setting.
    const optionButtons = document.querySelectorAll(
        ".option-button[data-setting]",
    );
    optionButtons.forEach((btn) => {
        const setting = btn.dataset.setting;
        const value = btn.dataset.value;
        btn.addEventListener("click", () => {
            switch (setting) {
                case "theme":
                    setTheme(value);
                    break;
                case "font":
                    setFont(value);
                    break;
                case "alignment":
                    setAlignment(value);
                    break;
                case "line-height":
                    setLineHeight(value);
                    break;
                case "hyphenation":
                    setHyphenation(value);
                    break;
                case "reading-mode":
                    setReadingMode(value);
                    break;
                case "columns":
                    setColumns(value);
                    break;
            }
        });
    });

    // Font size controls
    fontSizeDecrease.addEventListener("click", () => {
        setFontSize(currentSettings.fontSize - 2);
    });
    fontSizeIncrease.addEventListener("click", () => {
        setFontSize(currentSettings.fontSize + 2);
    });

    resetSettingsButton.addEventListener("click", () => {
        Object.assign(currentSettings, defaults);
        applySettingsSnapshot(currentSettings);
    });

    // Apply initial settings and update selected buttons
    applySettingsSnapshot(currentSettings, {
        persist: false,
        restorePosition: false,
    });

    // Build the initial TOC and update image sources once the content is ready.
    buildTOC();

    // Inject chapter navigation elements for chapter mode.
    injectChapterNavElements();

    // Finish startup: sync viewport, constrain images, restore position.
    // Uses a single rAF so the browser has one frame to apply CSS classes
    // set by applySettingsSnapshot before we measure layout.
    // Hide content until position is restored to avoid flashing page 1.
    document.body.classList.add("layout-pending");
    savedPosition = await positionPromise;
    requestAnimationFrame(() => {
        finishLayoutRefresh(() => {
            document.body.classList.remove("layout-pending");
        });
    });

    // Save position on scroll in scroll mode (debounced).
    // Also auto-hide/show chrome based on scroll direction.
    let scrollSaveTimeout = null;
    let userHasScrolled = false; // ignore programmatic scrolls during startup

    window.addEventListener(
        "scroll",
        () => {
            if (
                currentSettings.readingMode !== "scroll" &&
                currentSettings.readingMode !== "chapter"
            ) {
                return;
            }

            // Auto-hide/show chrome based on scroll direction.
            // Skip until the user actually scrolls (not programmatic restore).
            const sy = window.scrollY;
            const delta = sy - lastScrollY;
            lastScrollY = sy;

            if (userHasScrolled && !programmaticScroll && Math.abs(delta) > 2) {
                if (delta > 0 && chromeVisible) {
                    setChromeVisible(false);
                } else if (delta < 0 && !chromeVisible) {
                    setChromeVisible(true);
                }
            }

            if (scrollSaveTimeout) {
                clearTimeout(scrollSaveTimeout);
            }
            scrollSaveTimeout = setTimeout(() => {
                refreshUi(savePosition());
            }, 300);
        },
        { passive: true },
    );

    // Mark user-initiated scrolling after the first touch/wheel/key interaction.
    function markUserScrolled() {
        if (!userHasScrolled) {
            userHasScrolled = true;
        }
    }
    window.addEventListener("touchstart", markUserScrolled, {
        passive: true,
        once: true,
    });
    window.addEventListener("wheel", markUserScrolled, {
        passive: true,
        once: true,
    });
    window.addEventListener("keydown", markUserScrolled, { once: true });

    // Recalculate pagination when viewport/layout changes.
    // Safari (especially iOS) does not reliably fire `window.resize` for all UI-driven
    // changes (address bar/toolbars, the aA text-size controls, pinch-zoom, etc.).
    // We listen to multiple signals and debounce the expensive recomputation.
    let lastInnerWidth = window.innerWidth;
    let lastOuterHeight = window.outerHeight;

    window.addEventListener("resize", () => {
        const iw = window.innerWidth;
        const oh = window.outerHeight;
        const widthChanged = iw !== lastInnerWidth;
        const outerHeightChanged = oh !== lastOuterHeight;
        lastInnerWidth = iw;
        lastOuterHeight = oh;
        // Skip when only innerHeight shrank (Firefox find bar / menu bar).
        if (widthChanged || outerHeightChanged) {
            // In scroll/chapter mode, height-only changes (URL bar
            // collapse on iOS) must not trigger position restore —
            // that would interrupt the user's scroll.
            if (!widthChanged && currentSettings.readingMode !== "page") {
                return;
            }
            requestLayoutRecalc();
        }
    });
    window.addEventListener("orientationchange", () => {
        requestLayoutRecalc();
    });

    if (window.visualViewport) {
        // visualViewport is the most reliable signal on mobile Safari for UI chrome changes.
        // We listen to both resize and scroll because some browser UI transitions
        // surface inconsistently across engines, but only trigger a relayout when
        // the visual viewport dimensions actually changed.
        let lastVpWidth = window.visualViewport.width;
        let lastVpHeight = window.visualViewport.height;

        function recalcOnViewportResize() {
            const w = window.visualViewport.width;
            const h = window.visualViewport.height;
            if (w !== lastVpWidth || h !== lastVpHeight) {
                const vpWidthChanged = w !== lastVpWidth;
                lastVpWidth = w;
                lastVpHeight = h;
                // Width or outer-height change → full relayout (which includes syncViewportOffset).
                // Height-only change (URL bar show/hide) → just update the CSS variable.
                if (vpWidthChanged || window.outerHeight !== lastOuterHeight) {
                    // In scroll/chapter mode, skip full relayout for
                    // height-only changes to avoid interrupting scroll.
                    if (
                        vpWidthChanged ||
                        currentSettings.readingMode === "page"
                    ) {
                        requestLayoutRecalc();
                    }
                } else {
                    syncViewportOffset();
                }
            }
        }
        window.visualViewport.addEventListener(
            "resize",
            recalcOnViewportResize,
        );
        window.visualViewport.addEventListener(
            "scroll",
            recalcOnViewportResize,
        );
    }

    // Close panels when the Escape key is pressed, and handle arrow keys for pagination.
    // Intercept F11 to use Fullscreen API.

    function isAnyPanelOpen() {
        return (
            (modal && modal.classList.contains("open")) ||
            settingsPanel.classList.contains("open") ||
            tocPanel.classList.contains("open")
        );
    }

    function closeAllOpenPanels() {
        if (modal && modal.classList.contains("open")) {
            closeNoteModal();
        }
        closePanels();
    }

    function enterFullscreen() {
        document.documentElement
            .requestFullscreen()
            .then(() => {
                if (navigator.keyboard && navigator.keyboard.lock) {
                    navigator.keyboard.lock(["Escape"]).catch(() => {});
                }
            })
            .catch(() => {});
    }

    function exitFullscreen() {
        if (navigator.keyboard && navigator.keyboard.unlock) {
            navigator.keyboard.unlock();
        }
        document.exitFullscreen().catch(() => {});
    }

    // Fullscreen toggle (only shown when Fullscreen API is available)
    if (document.fullscreenEnabled || document.webkitFullscreenEnabled) {
        fullscreenToggle.hidden = false;

        function updateFullscreenButton() {
            const isFs = Boolean(
                document.fullscreenElement || document.webkitFullscreenElement,
            );
            fullscreenEnterIcon.style.display = isFs ? "none" : "";
            fullscreenExitIcon.style.display = isFs ? "" : "none";
            fullscreenToggle.title = isFs ? "Свернуть" : "Во весь экран";
        }

        fullscreenToggle.addEventListener("click", () => {
            if (
                document.fullscreenElement ||
                document.webkitFullscreenElement
            ) {
                exitFullscreen();
            } else {
                enterFullscreen();
            }
        });

        function onFullscreenChange() {
            updateFullscreenButton();
            // Fullscreen transition happens in multiple phases: the
            // fullscreenchange event fires first, then a resize event
            // delivers the final layout geometry (e.g. outer height change
            // as browser UI hides).  The debounce in requestLayoutRecalc
            // coalesces both phases into a single refresh.
            requestLayoutRecalc();
        }
        document.addEventListener("fullscreenchange", onFullscreenChange);
        document.addEventListener("webkitfullscreenchange", onFullscreenChange);
    }

    document.addEventListener("keydown", (e) => {
        if (e.key === "F11") {
            e.preventDefault();
            if (document.fullscreenElement) {
                exitFullscreen();
            } else {
                enterFullscreen();
            }
            return;
        }
        if (e.key === "Escape" || e.key === "Esc") {
            if (document.fullscreenElement) {
                // keyboard.lock worked: ESC comes as a normal keydown.
                // In firefox it does not work =(
                if (isAnyPanelOpen()) {
                    e.preventDefault();
                    closeAllOpenPanels();
                } else {
                    exitFullscreen();
                }
            } else if (modal && modal.classList.contains("open")) {
                closeNoteModal();
            } else {
                closePanels();
            }
        }
        // Arrow key navigation in page mode.
        // Skip when Shift is held so the user can extend a text selection.
        if (currentSettings.readingMode === "page" && !e.shiftKey) {
            if (e.key === "ArrowLeft") {
                setChromeVisible(false);
                goToPrevPage();
            } else if (e.key === "ArrowRight") {
                setChromeVisible(false);
                goToNextPage();
            }
        }
        // Space / Shift+Space navigation in page mode
        if (
            e.key === " " &&
            currentSettings.readingMode === "page" &&
            !isAnyPanelOpen()
        ) {
            e.preventDefault();
            setChromeVisible(false);
            if (e.shiftKey) {
                goToPrevPage();
            } else {
                goToNextPage();
            }
        }
        // Arrow key navigation in chapter mode (prev/next chapter)
        if (currentSettings.readingMode === "chapter" && !e.shiftKey) {
            if (e.key === "ArrowLeft" && currentChapterIndex > 0) {
                e.preventDefault();
                goToChapter(currentChapterIndex - 1);
            } else if (
                e.key === "ArrowRight" &&
                currentChapterIndex < meta.section_ids.length - 1
            ) {
                e.preventDefault();
                goToChapter(currentChapterIndex + 1);
            }
        }
    });

    // Show chrome when hovering over the header area (works even when hidden).
    readerHeader.addEventListener("mouseenter", () => {
        if (!chromeVisible) {
            setChromeVisible(true);
        }
    });
});
