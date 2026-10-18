/*
 * fb2.js — локальный конвертер FB2 → разметка читалки.
 *
 * Воспроизводит формат, который сервер fantasy-worlds.org отдаёт в
 * /book/{id}/read.html, чтобы оффлайн-приложение могло использовать
 * тот же движок чтения (reader.js) без изменений:
 *
 *   - <section id="sN" class="section level-K">, заголовок <hN><p>…</p></hN>
 *   - все абзацы получают сквозные id "p1".."pN" (paragraph_count)
 *   - #book-meta: { toc, section_ids, section_ranges, notes, … }
 *   - сноски: <a class="note__ref" data-note-id="…"> в тексте +
 *     <section id="notes" class="notes"> в конце
 *   - картинки (binary) встраиваются как data:-URL
 */

(function (global) {
    "use strict";

    const XLINK = "http://www.w3.org/1999/xlink";

    // ────────────────────────────────────────────────────────────────────
    // XML helpers
    // ────────────────────────────────────────────────────────────────────

    function firstNS(el, name) {
        if (!el) return null;
        for (let i = 0; i < el.childNodes.length; i++) {
            const n = el.childNodes[i];
            if (n.nodeType === 1 && n.localName === name) return n;
        }
        return null;
    }

    function childsNS(el, name) {
        const out = [];
        if (!el) return out;
        for (let i = 0; i < el.childNodes.length; i++) {
            const n = el.childNodes[i];
            if (n.nodeType === 1 && n.localName === name) out.push(n);
        }
        return out;
    }

    /** Текстовое содержимое элемента, свёрнутое в одну строку. */
    function textOf(el) {
        return el ? (el.textContent || "").replace(/\s+/g, " ").trim() : "";
    }

    function esc(s) {
        return String(s)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
    }

    /** href из FB2-ссылки: поддерживает l:href, xlink:href и голый href. */
    function hrefOf(el) {
        if (!el) return null;
        let h = el.getAttributeNS(XLINK, "href");
        if (h == null) h = el.getAttribute("l:href");
        if (h == null) h = el.getAttribute("xlink:href");
        if (h == null) h = el.getAttribute("href");
        return h;
    }

    /** Определить MIME по magic-байтам base64-данных. */
    function sniffMime(b64) {
        try {
            const bytes = Uint8Array.from(atob(b64.slice(0, 64)), (c) =>
                c.charCodeAt(0),
            );
            if (
                bytes.length >= 3 &&
                bytes[0] === 0xff &&
                bytes[1] === 0xd8
            ) {
                return "image/jpeg";
            }
            if (
                bytes.length >= 8 &&
                bytes[0] === 0x89 &&
                bytes[1] === 0x50 &&
                bytes[2] === 0x4e &&
                bytes[3] === 0x47
            ) {
                return "image/png";
            }
            if (
                bytes.length >= 6 &&
                bytes[0] === 0x47 &&
                bytes[1] === 0x49 &&
                bytes[2] === 0x46
            ) {
                return "image/gif";
            }
            if (
                bytes.length >= 4 &&
                bytes[0] === 0x52 &&
                bytes[1] === 0x49 &&
                bytes[2] === 0x46 &&
                bytes[3] === 0x46
            ) {
                return "image/webp";
            }
            if (
                bytes.length >= 2 &&
                bytes[0] === 0x42 &&
                bytes[1] === 0x4d
            ) {
                return "image/bmp";
            }
        } catch (e) {
            /* ignore */
        }
        return "image/png";
    }

    /** data:-URL бинарного образа по его FB2-id (или null). */
    function imageUri(el, ctx) {
        const h = hrefOf(el);
        if (!h || h[0] !== "#") return null;
        const id = h.slice(1);
        const bin = ctx.binaries.get(id);
        if (!bin) return null;
        const mime = bin.contentType || sniffMime(bin.content);
        return "data:" + mime + ";base64," + bin.content;
    }

    // ────────────────────────────────────────────────────────────────────
    // Inline (внутри абзаца)
    // ────────────────────────────────────────────────────────────────────

    function renderInline(el, ctx) {
        let out = "";
        for (let i = 0; i < el.childNodes.length; i++) {
            const n = el.childNodes[i];
            if (n.nodeType === 3) {
                out += esc(n.nodeValue);
                continue;
            }
            if (n.nodeType !== 1) continue;
            const tag = n.localName;
            switch (tag) {
                case "p":
                case "title":
                case "subtitle":
                case "annotation":
                case "empty-line":
                    out += renderInline(n, ctx);
                    break;
                case "emphasis":
                    out += "<em>" + renderInline(n, ctx) + "</em>";
                    break;
                case "strong":
                    out += "<strong>" + renderInline(n, ctx) + "</strong>";
                    break;
                case "strikethrough":
                    out += "<s>" + renderInline(n, ctx) + "</s>";
                    break;
                case "sub":
                    out += "<sub>" + renderInline(n, ctx) + "</sub>";
                    break;
                case "sup":
                    out += "<sup>" + renderInline(n, ctx) + "</sup>";
                    break;
                case "code":
                    out += "<code>" + renderInline(n, ctx) + "</code>";
                    break;
                case "a":
                    out += renderLink(n, ctx);
                    break;
                case "image": {
                    const uri = imageUri(n, ctx);
                    if (uri) out += '<img src="' + uri + '" alt="">';
                    break;
                }
                case "date":
                case "foreign":
                case "place":
                case "span":
                case "poem":
                case "stanza":
                case "v":
                case "text-author":
                case "cite":
                case "epigraph":
                    out += renderInline(n, ctx);
                    break;
                default:
                    if (n.childNodes.length) out += renderInline(n, ctx);
                    break;
            }
        }
        return out;
    }

    function renderLink(el, ctx) {
        const h = hrefOf(el);
        const inner = renderInline(el, ctx);
        if (!h) return inner;
        if (h[0] === "#") {
            const target = h.slice(1);
            if (ctx.isNoteId(target)) {
                ctx.refCounter += 1;
                const refId = "note-ref-" + ctx.refCounter;
                let list = ctx.noteRefs.get(target);
                if (!list) {
                    list = [];
                    ctx.noteRefs.set(target, list);
                }
                list.push(refId);
                return (
                    '<a class="note__ref" data-note-id="' +
                    esc(target) +
                    '" id="' +
                    refId +
                    '" href="#' +
                    esc(target) +
                    '">' +
                    (inner || "&#167;") +
                    "</a>"
                );
            }
            if (inner) {
                return '<a href="#' + esc(target) + '">' + inner + "</a>";
            }
            return "";
        }
        return (
            '<a href="' +
            esc(h) +
            '" target="_blank" rel="noopener">' +
            inner +
            "</a>"
        );
    }

    // ────────────────────────────────────────────────────────────────────
    // Блоки (абзацы, поэмы, таблицы и т.д.)
    // ────────────────────────────────────────────────────────────────────

    function renderTable(el, ctx) {
        let out = '<table class="fb2-table">';
        for (const tr of childsNS(el, "tr")) {
            out += "<tr>";
            const cells = childsNS(tr, "td");
            if (!cells.length) out += "<td></td>";
            for (const td of cells) {
                const blocks = renderBlocks(td, ctx, 1, null).trim();
                const inner = blocks || renderInline(td, ctx);
                out += "<td>" + inner + "</td>";
            }
            out += "</tr>";
        }
        out += "</table>";
        return out;
    }

    /**
     * Обойти блочные дети контейнера.
     * @param {Element} containerEl
     * @param {object} ctx
     * @param {number} level
     * @param {Array|null} tocOut — сюда вложенные <section> добавляют узлы оглавления
     * @param {Element|null} skipEl — ребёнок, который пропускаем (например <title> раздела)
     */
    function renderBlocks(containerEl, ctx, level, tocOut, skipEl) {
        let out = "";
        for (let i = 0; i < containerEl.childNodes.length; i++) {
            const n = containerEl.childNodes[i];
            if (n === skipEl) continue;
            if (n.nodeType === 3) {
                if (n.nodeValue.trim()) {
                    out += ctx.np(esc(n.nodeValue.trim()));
                }
                continue;
            }
            if (n.nodeType !== 1) continue;
            const tag = n.localName;
            switch (tag) {
                case "p":
                    out += ctx.np(renderInline(n, ctx));
                    break;
                case "empty-line":
                    out += '<div class="empty-line"></div>';
                    break;
                case "subtitle":
                    out += ctx.np(renderInline(n, ctx), "subtitle");
                    break;
                case "text-author":
                    out += ctx.np(renderInline(n, ctx), "text-author");
                    break;
                case "epigraph":
                    out +=
                        '<div class="epigraph">' +
                        renderBlocks(n, ctx, level, tocOut) +
                        "</div>";
                    break;
                case "poem":
                    out +=
                        '<div class="poem">' +
                        renderBlocks(n, ctx, level, tocOut) +
                        "</div>";
                    break;
                case "stanza":
                    out +=
                        '<div class="stanza">' +
                        renderBlocks(n, ctx, level, tocOut) +
                        "</div>";
                    break;
                case "v":
                    out += ctx.np(renderInline(n, ctx), "verse");
                    break;
                case "cite":
                    out += "<cite>" + renderInline(n, ctx) + "</cite>";
                    break;
                case "image": {
                    const uri = imageUri(n, ctx);
                    if (uri) {
                        out +=
                            '<div class="img-wrap"><img src="' +
                            uri +
                            '" alt=""></div>';
                    }
                    break;
                }
                case "annotation":
                    out +=
                        '<div class="annotation-block">' +
                        renderBlocks(n, ctx, level, tocOut) +
                        "</div>";
                    break;
                case "title":
                    // заголовок внутри поэмы/эпиграфа — как курсивная строка
                    out += ctx.np(renderInline(n, ctx), "stanza-title");
                    break;
                case "table":
                    out += renderTable(n, ctx);
                    break;
                case "section":
                    out += renderSection(n, level + 1, ctx, tocOut);
                    break;
                case "date":
                case "foreign":
                case "place":
                case "span":
                    out += ctx.np(renderInline(n, ctx));
                    break;
                default:
                    // неизвестный контейнер — разворачиваем его детей
                    if (n.childNodes.length) {
                        out += renderBlocks(n, ctx, level, tocOut);
                    }
                    break;
            }
        }
        return out;
    }

    // ────────────────────────────────────────────────────────────────────
    // Разделы (sections)
    // ────────────────────────────────────────────────────────────────────

    /** Заголовок раздела: <hN> с id-нумерованными абзацами. */
    function renderTitle(titleEl, ctx) {
        const texts = [];
        let html = "";
        const paras = childsNS(titleEl, "p");
        if (paras.length) {
            for (const p of paras) {
                html += ctx.np(renderInline(p, ctx));
                texts.push(textOf(p));
            }
        } else {
            html += ctx.np(renderInline(titleEl, ctx));
            texts.push(textOf(titleEl));
        }
        return { html: html, texts: texts };
    }

    function renderSection(secEl, level, ctx, tocOut) {
        // Сноски выносятся отдельно (extractNote) и не становятся разделами.
        const secId = secEl.getAttribute("id");
        if (secId && ctx.noteIds.has(secId)) {
            return "";
        }
        ctx.sectionCounter += 1;
        const id = "s" + ctx.sectionCounter;
        const node = { id: id, title: { paragraphs: [] }, children: [] };
        if (tocOut) tocOut.push(node);
        ctx.sectionIds.push(id);
        const pend = { id: id, start: ctx.pcount, end: -1 };
        ctx.pends.push(pend);

        let out = '<section id="' + id + '" class="section level-' + level + '">';

        const titleEl = firstNS(secEl, "title");
        if (titleEl) {
            const h = "h" + Math.min(6, level + 1);
            const t = renderTitle(titleEl, ctx);
            node.title.paragraphs = t.texts;
            out += "<" + h + ">" + t.html + "</" + h + ">";
        }

        out += renderBlocks(secEl, ctx, level, node.children, titleEl);
        out += "</section>";

        pend.end = ctx.pcount - 1;
        return out;
    }

    /** Титульная страница из <title-info> — синтетический раздел s1. */
    function buildTitlePage(titleInfo, ctx) {
        const id = "s1";
        ctx.sectionCounter += 1;
        const node = {
            id: id,
            title: { paragraphs: [] },
            children: [],
        };
        ctx.toc.push(node);
        ctx.sectionIds.push(id);
        const pend = { id: id, start: ctx.pcount, end: -1 };
        ctx.pends.push(pend);

        let out = '<section id="s1" class="section level-1">';

        const coverpage = firstNS(titleInfo, "coverpage");
        const coverImg = coverpage ? firstNS(coverpage, "image") : null;
        const coverUri = coverImg ? imageUri(coverImg, ctx) : null;
        if (coverUri) {
            ctx.cover = coverUri;
            out += '<div class="img-wrap"><img src="' + coverUri + '" alt="Обложка"></div>';
        }

        const authorText = titleInfoAuthors(titleInfo)
            .map(formatAuthor)
            .filter(Boolean)
            .join(", ");
        const bookTitle = textOf(firstNS(titleInfo, "book-title"));
        node.title.paragraphs = [authorText, bookTitle].filter(Boolean);
        out +=
            "<h2>" +
            ctx.np("<p>" + esc(authorText) + "</p>") +
            ctx.np("<p>" + esc(bookTitle) + "</p>") +
            "</h2>";

        const ann = firstNS(titleInfo, "annotation");
        if (ann) {
            out +=
                '<div id="annotation">' +
                renderBlocks(ann, ctx, 1, node.children) +
                "</div>";
        }

        out += "</section>";
        pend.end = ctx.pcount - 1;
        return out;
    }

    // ────────────────────────────────────────────────────────────────────
    // Сноски (notes)
    // ────────────────────────────────────────────────────────────────────

    function extractNote(secEl, ctx) {
        const id = secEl.getAttribute("id");
        if (!id) return null;

        const titleEl = firstNS(secEl, "title");
        const texts = [];
        if (titleEl) {
            for (const p of childsNS(titleEl, "p")) {
                texts.push(textOf(p));
            }
            if (!texts.length) texts.push(textOf(titleEl));
        }
        if (!texts.length) texts.push(id);

        // Тело сноски рендерим без сквозных id (не участвуют в позиции чтения),
        // счётчик абзацев не трогаем.
        const savedNoPids = ctx.noPids;
        const savedCount = ctx.pcount;
        ctx.noPids = true;
        const html = renderBlocks(secEl, ctx, 1, null, titleEl).trim();
        ctx.noPids = savedNoPids;
        ctx.pcount = savedCount;

        return {
            id: id,
            title: { paragraphs: texts },
            html: html,
            backrefs: ctx.noteRefs.get(id) || [],
        };
    }

    /** <section id="notes" class="notes"> в конце книги. */
    function buildNotesSection(notes) {
        if (!notes.length) return "";
        const arrow =
            '<svg width="14" height="14" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg"><path d="M13.5 4.5 7 11l6.5 6.5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" transform="rotate(180 10 10)"/></svg>';
        let out = '<section id="notes" class="notes">';
        for (const note of notes) {
            const backrefs = (note.backrefs || [])
                .map(
                    (refId) =>
                        '<a class="note__backref" href="#' +
                        esc(refId) +
                        '" title="Вернуться к месту чтения">' +
                        arrow +
                        "</a>",
                )
                .join("");
            const title =
                (note.title.paragraphs[0] &&
                    note.title.paragraphs[0].replace(/^(\d+)\s*[.)]?\s*/, "$1.")) ||
                note.id;
            out +=
                '<div class="note" id="note-' +
                esc(note.id) +
                '">' +
                '<span class="note__title">' +
                esc(title) +
                "</span>" +
                '<div class="note__body">' +
                note.html +
                "</div>" +
                '<span class="note__backrefs">' +
                backrefs +
                "</span>" +
                "</div>";
        }
        out += "</section>";
        return out;
    }

    // ────────────────────────────────────────────────────────────────────
    // Метаданные из <title-info>
    // ────────────────────────────────────────────────────────────────────

    function titleInfoAuthors(titleInfo) {
        return childsNS(titleInfo, "author").map((a) => ({
            name: textOf(firstNS(a, "first-name")),
            middleName: textOf(firstNS(a, "middle-name")),
            surname: textOf(firstNS(a, "last-name")),
            nickname: textOf(firstNS(a, "nickname")),
        }));
    }

    function formatAuthor(a) {
        if (a.nickname) return a.nickname;
        return [a.name, a.middleName, a.surname].filter(Boolean).join(" ");
    }

    function parseSequences(titleInfo) {
        function one(el) {
            const name = el.getAttribute("name");
            if (!name) return null;
            const n = parseInt(el.getAttribute("number") || "", 10);
            const node = {
                name: name,
                number: Number.isFinite(n) ? n : null,
            };
            const child = firstNS(el, "sequence");
            if (child) {
                const c = one(child);
                if (c) node.child = c;
            }
            return node;
        }
        return childsNS(titleInfo, "sequence")
            .map(one)
            .filter(Boolean);
    }

    // ────────────────────────────────────────────────────────────────────
    // Конвертация целиком
    // ────────────────────────────────────────────────────────────────────

    /**
     * Разобрать FB2 и вернуть { meta, content_html, error? }.
     * meta.book_id заполняет вызывающий код (после вычисления хеша).
     */
    function convertFb2Xml(doc) {
        if (
            doc.getElementsByTagName("parsererror").length ||
            doc.documentElement.localName !== "FictionBook"
        ) {
            throw new Error("Файл не похож на корректный FB2 (XML-ошибка)");
        }

        const root = doc.documentElement;
        const description = firstNS(root, "description");
        if (!description) {
            throw new Error("В FB2 нет блока <description>");
        }
        const titleInfo = firstNS(description, "title-info");
        if (!titleInfo) {
            throw new Error("В FB2 нет <title-info>");
        }
        const documentInfo = firstNS(description, "document-info");

        // Бинарные образы (картинки)
        const binaries = new Map();
        for (const b of childsNS(root, "binary")) {
            if (b.getAttribute("id")) {
                binaries.set(b.getAttribute("id"), {
                    content: (b.textContent || "").trim(),
                    contentType: b.getAttribute("content-type") || "",
                });
            }
        }

        // Тела документа
        const bodies = childsNS(root, "body");
        const mainBody = bodies.find((b) => !b.getAttribute("name")) || bodies[0];
        const notesBody = bodies.find((b) => b.getAttribute("name") === "notes");

        // Pass 1: собрать id сносок, чтобы refs в тексте распознавались.
        const noteIdSet = new Set();
        const collectNoteIds = (secEl) => {
            const id = secEl.getAttribute("id");
            if (id && /^n[\w-]*$/i.test(id)) noteIdSet.add(id);
            for (const s of childsNS(secEl, "section")) {
                collectNoteIds(s);
            }
        };
        if (mainBody) {
            for (const s of childsNS(mainBody, "section")) {
                collectNoteIds(s);
            }
        }
        if (notesBody) {
            for (const s of childsNS(notesBody, "section")) {
                collectNoteIds(s);
            }
        }

        // Pass 2: рендер.
        const ctx = {
            binaries: binaries,
            pcount: 1,
            noPids: false,
            sectionCounter: 0,
            toc: [],
            sectionIds: [],
            pends: [],
            notes: [],
            noteIds: noteIdSet,
            noteRefs: new Map(),
            refCounter: 0,
            cover: null,
            np: function (inner, cls) {
                const id = "p" + this.pcount;
                this.pcount += 1;
                const attr = cls ? ' class="' + cls + '"' : "";
                const open = this.noPids
                    ? "<p" + attr + ">"
                    : '<p' + attr + ' id="' + id + '">';
                return open + inner + "</p>";
            },
            isNoteId: function (t) {
                return this.noteIds.has(t);
            },
        };

        let contentHtml = "";
        contentHtml += buildTitlePage(titleInfo, ctx);

        if (mainBody) {
            for (const s of childsNS(mainBody, "section")) {
                contentHtml += renderSection(s, 1, ctx, ctx.toc);
            }
        }
        // Дополнительные именованные тела (кроме сносок) — как обычный контент
        for (const b of bodies) {
            const n = b.getAttribute("name");
            if (n && n !== "notes" && b !== mainBody) {
                for (const s of childsNS(b, "section")) {
                    contentHtml += renderSection(s, 1, ctx, ctx.toc);
                }
            }
        }

        // Извлечение сносок из основного тела и <body name="notes">
        const noteSections = [];
        const gatherNoteSections = (secEl) => {
            const id = secEl.getAttribute("id");
            if (id && ctx.noteIds.has(id)) noteSections.push(secEl);
            for (const s of childsNS(secEl, "section")) {
                gatherNoteSections(s);
            }
        };
        if (mainBody) {
            for (const s of childsNS(mainBody, "section")) {
                gatherNoteSections(s);
            }
        }
        if (notesBody) {
            for (const s of childsNS(notesBody, "section")) {
                noteSections.push(s);
            }
        }
        for (const sec of noteSections) {
            const note = extractNote(sec, ctx);
            if (note) ctx.notes.push(note);
        }

        contentHtml += buildNotesSection(ctx.notes);

        // ── Метаданные ──
        const lang =
            textOf(firstNS(titleInfo, "lang")) ||
            textOf(firstNS(documentInfo, "lang")) ||
            "ru";
        const isbns = childsNS(titleInfo, "isbn")
            .map(textOf)
            .filter(Boolean);
        const genres = childsNS(titleInfo, "genre")
            .map(textOf)
            .filter(Boolean);
        const keywords = (
            textOf(firstNS(titleInfo, "keywords")) ||
            textOf(firstNS(documentInfo, "keywords")) ||
            ""
        )
            .split(/[;,]/)
            .map((s) => s.trim())
            .filter(Boolean);

        const yearMatch = textOf(firstNS(titleInfo, "date")).match(/\d{4}/);
        const year = yearMatch ? parseInt(yearMatch[0], 10) : null;

        const ann = firstNS(titleInfo, "annotation");
        const annotationHtml = ann
            ? renderBlocks(ann, {
                  binaries: binaries,
                  pcount: 1,
                  noPids: true,
                  np: function (inner) {
                      return "<p>" + inner + "</p>";
                  },
                  isNoteId: function () {
                      return false;
                  },
              }, 1, null)
            : null;

        const rangesById = new Map();
        for (const p of ctx.pends) {
            rangesById.set(p.id, { start: p.start, end: p.end });
        }
        const section_ranges = ctx.sectionIds.map((id) => {
            const r = rangesById.get(id);
            if (!r || r.start > r.end) return null;
            return { start: r.start, end: r.end };
        });

        const meta = {
            lang: lang,
            title: textOf(firstNS(titleInfo, "book-title")),
            isbn: isbns.length ? isbns.join(", ") : null,
            publisher: textOf(firstNS(titleInfo, "publisher")) || null,
            year: year,
            authors: titleInfoAuthors(titleInfo).map((a) => ({
                name: a.name || null,
                surname: a.surname || null,
                nickname: a.nickname || null,
            })),
            genres: genres,
            keywords: keywords,
            toc: ctx.toc,
            section_ids: ctx.sectionIds,
            notes: ctx.notes,
            images: ctx.cover ? [{ id: "cover", size: null }] : [],
            paragraph_count: ctx.pcount - 1,
            section_ranges: section_ranges,
            annotation: annotationHtml,
            cover: ctx.cover,
            sequences: parseSequences(titleInfo),
        };

        return { meta: meta, content_html: contentHtml };
    }

    /**
     * Прочитать файл с учётом кодировки из XML-пролога (многие FB2 в cp1251).
     * Пробуем декодировать заявленной кодировкой, затем utf-8 и windows-1251.
     * @param {ArrayBuffer} buffer
     * @returns {string}
     */
    function decodeFb2Buffer(buffer) {
        const head = new TextDecoder("utf-8").decode(buffer.slice(0, 1024));
        let charset = null;
        const m = head.match(/<\?xml[^>]*encoding\s*=\s*["']([^"']+)["']/i);
        if (m) charset = m[1];
        const candidates = [];
        if (charset) candidates.push(charset);
        candidates.push("utf-8", "windows-1251");
        for (const cs of [...new Set(candidates)]) {
            try {
                const text = new TextDecoder(cs, { fatal: true }).decode(buffer);
                // После декодирования должен получиться XML
                if (
                    text.includes("<") &&
                    text.includes(">") &&
                    /<\?xml|<\s*FictionBook/.test(text)
                ) {
                    return text;
                }
            } catch (e) {
                /* пробуем следующую кодировку */
            }
        }
        return new TextDecoder("utf-8").decode(buffer);
    }

    /**
     * Конвертация FB2-текста в данные читалки.
     * @param {string} xmlText
     * @returns {{meta: object, content_html: string}}
     */
    function convertFb2Text(xmlText) {
        const doc = new DOMParser().parseFromString(xmlText, "application/xml");
        return convertFb2Xml(doc);
    }

    /** Стабильный id книги по содержимому (SHA-256, фолбэк — djb2). */
    async function computeBookId(text) {
        const fallback = () => {
            let h = 5381;
            for (let i = 0; i < Math.min(text.length, 4096); i++) {
                h = (h * 33) ^ text.charCodeAt(i);
            }
            return "fb2-" + (h >>> 0).toString(16).padStart(8, "0");
        };
        if (global.crypto && global.crypto.subtle) {
            try {
                const buf = await global.crypto.subtle.digest(
                    "SHA-256",
                    new TextEncoder().encode(text),
                );
                const hex = Array.from(new Uint8Array(buf))
                    .slice(0, 12)
                    .map((b) => b.toString(16).padStart(2, "0"))
                    .join("");
                return "fb2-" + hex;
            } catch (e) {
                return fallback();
            }
        }
        return fallback();
    }

    const api = {
        convertFb2Text: convertFb2Text,
        convertFb2Xml: convertFb2Xml,
        decodeFb2Buffer: decodeFb2Buffer,
        computeBookId: computeBookId,
    };

    if (typeof module !== "undefined" && module.exports) {
        module.exports = api;
    }
    global.Fb2Converter = api;
})(typeof window !== "undefined" ? window : globalThis);