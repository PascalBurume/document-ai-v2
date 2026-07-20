import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TopBar } from './components/TopBar';
import { DocBar } from './components/DocBar';
import { Viewer } from './components/Viewer';
import { ResultPane, TABS } from './components/ResultPane';
import { ConfigPanel } from './components/ConfigPanel';
import { CodeModal } from './components/CodeModal';
import { Home } from './components/Home';
import { runOcr, health } from './lib/api';
import { applyAuthoredFigures } from './lib/authoredFigures';
import { forgetPdf, makeThumbnail, pdfPageCount, readFileAsDataUri } from './lib/pdf';
import { downloadAll } from './lib/download';
import { exportHtml } from './lib/convert';
import {
  clearSession,
  deleteFromLibrary,
  listLibrary,
  loadFromLibrary,
  loadSession,
  migrateLegacyLibrary,
  saveSession,
  saveToLibrary,
  updateLibraryThumb,
  type LibraryMeta,
} from './lib/store';
import { fetchCacheStats, fetchEditStats, type CacheStats, type EditStats } from './lib/telemetry';
import { DEFAULT_CONFIG, type Block, type DocFile, type OcrConfig, type OcrPage } from './lib/types';
import { buildPageMarks } from './lib/suspects';
import { epureFiguresFor, epureFiguresForSourceBlock } from './lib/epureCatalog';
import { fetchEdits, saveEdit } from './lib/edits';

export type Tab = 'text' | 'visual' | 'markdown' | 'convert' | 'book' | 'edit' | 'epure';

/** The block hovered or selected, shared by every pane. This is the two-way link. */
export interface Selection {
  pageIndex: number;
  blockId: string;
}

let nextId = 0;

export default function App() {
  const [docs, setDocs] = useState<DocFile[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [config, setConfig] = useState<OcrConfig>(DEFAULT_CONFIG);
  const [tab, setTab] = useState<Tab>('text');
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [fitWidth, setFitWidth] = useState(true);
  const [hovered, setHovered] = useState<Selection | null>(null);
  const [selected, setSelected] = useState<Selection | null>(null);
  // Which épure the Épure tab is on. Up here because a figure row in Convert opens one directly,
  // and the tab is a sibling of the row, not its parent.
  const [epure, setEpure] = useState<string | null>(null);
  const [configOpen, setConfigOpen] = useState(false);
  const [codeOpen, setCodeOpen] = useState(false);
  const [keyMissing, setKeyMissing] = useState(false);
  const [mock, setMock] = useState(false);
  /** Every document ever finished, newest first — metadata only until one is opened. */
  const [library, setLibrary] = useState<LibraryMeta[]>([]);
  /** Home-screen telemetry — decoration, so either may be null when the server is unreachable. */
  const [editStats, setEditStats] = useState<EditStats | null>(null);
  const [cacheStats, setCacheStats] = useState<CacheStats | null>(null);
  /** Briefly true after a run finishes, so a cached run that changes nothing still shows it ran. */
  const [flash, setFlash] = useState(false);
  const flashTimer = useRef<number>();
  const fileInput = useRef<HTMLInputElement>(null);

  const active = docs.find((d) => d.id === activeId) ?? null;
  /** Config changes since the last run — the Run button says so. */
  const [dirty, setDirty] = useState(false);
  /** False until the persisted session has been read, so the first checkpoint can't clobber it. */
  const hydrated = useRef(false);
  /** Keyboard-nav cursor through this document's suspect spans (n / N). -1 = not started. */
  const [suspectCursor, setSuspectCursor] = useState(-1);
  /** Surfaced if a correction could not be written to the durable store — never silently dropped. */
  const [editSaveError, setEditSaveError] = useState<string | null>(null);
  /** Surfaced if the workspace itself could not be checkpointed (quota, private mode). */
  const [saveError, setSaveError] = useState<string | null>(null);
  /** When the active document was last filed in the library — the "your work is safe" signal. */
  const [savedAt, setSavedAt] = useState<number | null>(null);
  /**
   * The page a restored session was left on, handed to the panes so they can scroll there once
   * their content exists. Cleared shortly after, so it only ever drives the first mount.
   */
  const [restorePage, setRestorePage] = useState<number | null>(null);
  /** Documents whose stored corrections have already been pulled in, so we ask once per document. */
  const editsLoaded = useRef<Set<string>>(new Set());

  useEffect(() => {
    health()
      .then((h) => {
        setKeyMissing(!h.keyConfigured);
        setMock(Boolean(h.mock));
      })
      .catch(() => setKeyMissing(true));
  }, []);

  const refreshLibrary = useCallback(() => {
    void listLibrary().then(setLibrary);
  }, []);

  // Hand over anything the old in-browser library still holds before painting the list, so an
  // entry never flickers in as "missing" on the one load that is about to rescue it.
  useEffect(() => {
    void migrateLegacyLibrary().then(refreshLibrary);
  }, [refreshLibrary]);

  const refreshTelemetry = useCallback(() => {
    void fetchEditStats().then(setEditStats);
    void fetchCacheStats().then(setCacheStats);
  }, []);

  useEffect(refreshTelemetry, [refreshTelemetry]);

  // Restore the last session (documents + their paid-for results) so a reload doesn't force a
  // re-run. Runs once, before any checkpoint is allowed to write.
  useEffect(() => {
    let cancelled = false;
    loadSession()
      .then(async (s) => {
        if (cancelled || !s?.docs?.length) return;
        setDocs(s.docs);
        // A stored null means the session was left on the home screen — honor it. Only an id that
        // no longer resolves falls back to the first document.
        setActiveId(
          s.activeId === null ? null : s.docs.some((d) => d.id === s.activeId) ? s.activeId : s.docs[0].id,
        );
        if (s.config) setConfig(s.config);

        // Put the view back too, not just the documents. A discarded tab (locking the screen is
        // enough) reloads into a fresh mount, and without this you return to the first tab at
        // page 1 — which reads as "the app restarted and lost my place".
        if (s.view) {
          if (TABS.some((t) => t.id === s.view!.tab)) setTab(s.view.tab as Tab);
          if (s.view.zoom > 0) setZoom(s.view.zoom);
          setFitWidth(s.view.fitWidth);
          const wanted = Math.min(Math.max(1, Math.round(s.view.page)), s.docs[0]?.pageCount ?? 1);
          setPage(wanted);
          // The panes cannot simply be told a page: each mounts scrolled at the top and its own
          // scroll-spy would report page 1 straight back. `restorePage` is the instruction to jump
          // there once their content exists, holding their spy until it lands.
          if (wanted > 1) setRestorePage(wanted);
        }

        // Keep freshly added documents from reusing a restored id.
        nextId = Math.max(nextId, ...s.docs.map((d) => (Number(d.id.replace(/\D/g, '')) || 0) + 1));

        // Backfill: a document finished before the library existed (or in a session that predates
        // it) is still a paid result. File it, so it is reopenable like everything since.
        const orphans = s.docs.filter((d) => d.result && !d.libKey);
        if (!orphans.length) return;
        const keyed = await Promise.all(
          orphans.map(async (d) => {
            try {
              return [d.id, await saveToLibrary(d, s.config ?? DEFAULT_CONFIG, Date.now(), await makeThumbnail(d))] as const;
            } catch {
              return [d.id, null] as const; // the workspace still has it; the banner will say so on the next save
            }
          }),
        );
        if (cancelled) return;
        setDocs((prev) =>
          prev.map((d) => {
            const key = keyed.find(([id]) => id === d.id)?.[1];
            return key ? { ...d, libKey: key } : d;
          }),
        );
        refreshLibrary();
      })
      .finally(() => {
        if (!cancelled) hydrated.current = true;
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Checkpoint the session on change — but never mid-run (progress ticks would rewrite the result
  // on every chunk), and never before hydration (that would overwrite the stored session with the
  // empty initial state). Debounced so a burst of updates writes once. The document bytes are NOT
  // rewritten by a checkpoint (see store.ts), so a figure sweep's per-figure saves are cheap.
  //
  // A failure is surfaced, never swallowed: after an hour of paid redraws, "your progress is not
  // being saved" has to reach the person watching, not just the console.
  useEffect(() => {
    if (!hydrated.current || docs.some((d) => d.running)) return;
    const t = window.setTimeout(() => {
      saveSession({ docs, activeId, config, view: { tab, page, zoom, fitWidth } })
        .then(() => setSaveError(null))
        .catch((err: Error) => setSaveError(err.message));
    }, 400);
    return () => window.clearTimeout(t);
  }, [docs, activeId, config, tab, page, zoom, fitWidth]);

  const patchDoc = useCallback((id: string, patch: Partial<DocFile>) => {
    setDocs((prev) => prev.map((d) => (d.id === id ? { ...d, ...patch } : d)));
  }, []);

  /**
   * File the active document's current state — redraws, label checks, recovered text and all — in
   * the library, which is the copy that survives Restart and a cleared session.
   *
   * The session checkpoint above already persists this work, but only for THIS workspace: the
   * library entry was written once, when the OCR run finished, so everything paid for afterwards
   * (a whole figure sweep) lived only in the session until now. Called when a sweep finishes,
   * before Restart throws the workspace away, and when the tab is hidden.
   */
  const saveProgress = useCallback(async (): Promise<boolean> => {
    const doc = docs.find((d) => d.id === activeId);
    if (!doc?.result) return false;
    try {
      // Only render a thumbnail when the entry has none. Making one decodes the whole PDF and
      // renders a page — pointless work on every save when `saveToLibrary` already carries the
      // stored thumbnail forward.
      const hasThumb = Boolean(doc.libKey && library.find((m) => m.key === doc.libKey)?.thumb);
      const key = await saveToLibrary(doc, config, Date.now(), hasThumb ? undefined : await makeThumbnail(doc));
      if (key && !doc.libKey) patchDoc(doc.id, { libKey: key });
      refreshLibrary();
      setSaveError(null);
      setSavedAt(Date.now());
      return true;
    } catch (err) {
      setSaveError((err as Error).message);
      return false;
    }
  }, [docs, activeId, config, library, patchDoc, refreshLibrary]);

  /**
   * Flush the workspace when the tab goes to the background — a locked screen, a switched tab.
   *
   * Deliberately the CHEAP save: the session checkpoint, which no longer carries the document's
   * bytes. It used to file the whole library entry here (a multi-megabyte write plus a fresh
   * page render for the thumbnail) at the exact moment the browser is deciding whether this tab
   * is worth keeping — a memory spike then invites the discard it was trying to survive. The
   * session is what a discard reloads from, so the session is what needs to be current; the
   * library copy is filed at the points that actually need it (a finished sweep, Restart).
   */
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState !== 'hidden' || !hydrated.current) return;
      saveSession({ docs, activeId, config, view: { tab, page, zoom, fitWidth } }).catch(() => {
        /* no UI left to show it in; the next foreground save reports it */
      });
    };
    document.addEventListener('visibilitychange', onHide);
    return () => document.removeEventListener('visibilitychange', onHide);
  }, [docs, activeId, config, tab, page, zoom, fitWidth]);

  // The restore instruction is spent once the panes have had their chance to act on it: it must
  // not fire again if a pane later remounts for an unrelated reason.
  useEffect(() => {
    if (restorePage == null) return;
    const t = window.setTimeout(() => setRestorePage(null), 4000);
    return () => window.clearTimeout(t);
  }, [restorePage]);

  /**
   * Ask the browser to stop treating this origin's storage as disposable. Without it, IndexedDB is
   * "best-effort": a session holding a 40MB scan and hours of paid redraws is a candidate for
   * eviction under storage pressure. Fire-and-forget — a refusal changes nothing we can act on.
   */
  useEffect(() => {
    void navigator.storage?.persist?.().catch(() => {});
  }, []);

  // Hand-drawn figures for a known book are applied to its blocks as soon as the document has a
  // result — whether it came from a fresh run, the session, or the library. `applyAuthoredFigures`
  // returns the same object when there is nothing to do, so this cannot loop.
  useEffect(() => {
    setDocs((prev) => {
      const next = prev.map((d) => (d.result ? applyAuthoredFigures(d) : d));
      return next.some((d, i) => d !== prev[i]) ? next : prev;
    });
  }, [docs]);

  /**
   * Attach an AI figure redraw to its block. Stored on the block on purpose: the session
   * checkpoint persists results wholesale, so a paid redraw survives reloads and every export
   * reuses it without another API call.
   */
  const patchBlock = useCallback((docId: string, pageIndex: number, blockId: string, patch: Partial<Block>) => {
    setDocs((prev) =>
      prev.map((d) => {
        if (d.id !== docId || !d.result) return d;
        return {
          ...d,
          result: {
            ...d.result,
            pages: d.result.pages.map((p) =>
              p.index !== pageIndex
                ? p
                : { ...p, blocks: p.blocks.map((b) => (b.id === blockId ? { ...b, ...patch } : b)) },
            ),
          },
        };
      }),
    );
  }, []);

  /**
   * Patch one page of a document's result (e.g. its persisted vision second-opinion). Like
   * `patchBlock`, this writes onto the result the session checkpoint persists, so a paid reading
   * survives reloads and is never re-billed. It never touches `markdown` — the evidence is immutable.
   */
  const patchPage = useCallback((docId: string, pageIndex: number, patch: Partial<OcrPage>) => {
    setDocs((prev) =>
      prev.map((d) => {
        if (d.id !== docId || !d.result) return d;
        return {
          ...d,
          result: {
            ...d.result,
            pages: d.result.pages.map((p) => (p.index === pageIndex ? { ...p, ...patch } : p)),
          },
        };
      }),
    );
  }, []);

  // Re-attach the corrections stored on disk for this document. This is the half that makes edits
  // outlive the browser: a reopened library entry, a cleared IndexedDB, or the same scan dropped in
  // on another machine all resolve to the same content hash and get their corrections back. Asked
  // once per document; a document nobody has edited costs one 200 with an empty map.
  useEffect(() => {
    for (const d of docs) {
      const key = d.libKey;
      if (!key || !d.result || editsLoaded.current.has(key)) continue;
      editsLoaded.current.add(key);
      const id = d.id;
      void fetchEdits(key).then((map) => {
        if (!Object.keys(map).length) return;
        setDocs((prev) =>
          prev.map((doc) => {
            if (doc.id !== id || !doc.result) return doc;
            return {
              ...doc,
              result: {
                ...doc.result,
                pages: doc.result.pages.map((p) => {
                  const stored = map[String(p.index)];
                  return stored != null && stored !== p.editedMarkdown ? { ...p, editedMarkdown: stored } : p;
                }),
              },
            };
          }),
        );
      });
    }
  }, [docs]);

  /**
   * A human correction, written through to disk as well as the session. The local patch is applied
   * first and never waits on the network: the edit must land instantly and survive even if the
   * server write fails (it is still in IndexedDB). The server copy is what makes it outlive THIS
   * browser — keyed by the document's content hash, so it re-attaches to the same scan anywhere.
   */
  const editPage = useCallback(
    (docId: string, pageIndex: number, patch: Partial<OcrPage>) => {
      patchPage(docId, pageIndex, patch);
      const target = docs.find((d) => d.id === docId);
      if (!target?.libKey || !('editedMarkdown' in patch)) return;
      saveEdit(target.libKey, pageIndex, patch.editedMarkdown ?? null)
        .then(refreshTelemetry)
        .catch((err: Error) => setEditSaveError(err.message));
    },
    [docs, patchPage, refreshTelemetry],
  );

  const addFiles = useCallback(async (files: FileList | File[]) => {
    const incoming: DocFile[] = [];
    for (const file of Array.from(files)) {
      const isPdf = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
      const dataUri = await readFileAsDataUri(file);
      const pageCount = isPdf ? await pdfPageCount(dataUri).catch(() => 1) : 1;
      incoming.push({
        id: `doc-${nextId++}`,
        name: file.name,
        sizeBytes: file.size,
        mime: file.type || (isPdf ? 'application/pdf' : 'image/jpeg'),
        sourceType: isPdf ? 'document_url' : 'image_url',
        dataUri,
        pageCount,
      });
    }
    if (!incoming.length) return;
    setDocs((prev) => [...prev, ...incoming]);
    setActiveId((prev) => prev ?? incoming[0].id);
    setPage(1);
  }, []);

  /**
   * `force` bypasses the server's cache and pays for a fresh run. Everything else reuses an
   * already-processed document for free — OCR is billed per page, and a scan does not change.
   */
  const run = useCallback(async (force = false) => {
    if (!active || active.running) return;
    patchDoc(active.id, { running: true, error: undefined, progress: undefined });
    setDirty(false);
    try {
      const result = await runOcr(
        active,
        config,
        (done, total) => patchDoc(active.id, { progress: { done, total } }),
        force,
      );
      patchDoc(active.id, { result, running: false, progress: undefined });
      setSelected(null);
      setHovered(null);
      // Acknowledge the run even when the result is identical (a cache hit on an unchanged
      // config renders exactly the same pixels, so without this the click looks ignored).
      setFlash(true);
      window.clearTimeout(flashTimer.current);
      flashTimer.current = window.setTimeout(() => setFlash(false), 2500);
      // A finished run is the only thing worth keeping. Filed under its content hash, so it can
      // be reopened later from the home screen without an upload and without a second API call.
      // Its own try: a library that is full must not be reported as an OCR failure — the run
      // succeeded, and the result is on screen either way.
      try {
        const key = await saveToLibrary({ ...active, result }, config, Date.now(), await makeThumbnail(active));
        if (key) {
          patchDoc(active.id, { libKey: key });
          refreshLibrary();
          setSavedAt(Date.now());
        }
      } catch (err) {
        setSaveError((err as Error).message);
      }
      refreshTelemetry();
    } catch (err) {
      patchDoc(active.id, { error: (err as Error).message, running: false, progress: undefined });
    }
  }, [active, config, patchDoc, refreshLibrary, refreshTelemetry]);

  /**
   * Reopen an already-processed document: its pages, blocks, redraws and label checks come back
   * exactly as they were, with no upload and no run. Already open in this session → just switch
   * to it, rather than loading a second copy of the same megabytes.
   */
  const openFromLibrary = useCallback(async (key: string) => {
    const already = docs.find((d) => d.libKey === key);
    if (already) {
      setActiveId(already.id);
      setPage(1);
      setSelected(null);
      return;
    }
    const entry = await loadFromLibrary(key);
    if (!entry) {
      refreshLibrary(); // it was deleted from under us; the list is stale
      return;
    }
    const doc: DocFile = { ...entry.doc, id: `doc-${nextId++}` };
    setDocs((prev) => [...prev, doc]);
    setActiveId(doc.id);
    if (entry.config) setConfig(entry.config);
    setPage(1);
    setSelected(null);
    setHovered(null);
    setDirty(false);
  }, [docs, refreshLibrary]);

  const removeFromLibrary = useCallback(async (key: string) => {
    await deleteFromLibrary(key);
    refreshLibrary();
  }, [refreshLibrary]);

  /**
   * Back to the home screen without touching the workspace: the open documents, their results and
   * the config all stay exactly as they were. Restart is the destructive sibling, one menu deeper.
   */
  const goHome = useCallback(() => {
    setActiveId(null);
    setSelected(null);
    setHovered(null);
    refreshTelemetry();
  }, [refreshTelemetry]);

  /**
   * Entries saved before thumbnails existed get one backfilled while the home screen is up: load
   * the full entry once, render page 1 small, write it back to the metadata index. One at a time —
   * each write refreshes the library, which re-fires this effect until nothing is missing. Keys
   * that fail (corrupt PDF, canvas quota) are remembered so they can't retry in a loop.
   */
  const thumbTried = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (active) return;
    const missing = library.find((m) => !m.thumb && !thumbTried.current.has(m.key));
    if (!missing) return;
    thumbTried.current.add(missing.key);
    let cancelled = false;
    void (async () => {
      const entry = await loadFromLibrary(missing.key);
      if (!entry || cancelled) return;
      const tempId = `thumb-${missing.key}`;
      const thumb = await makeThumbnail({ ...entry.doc, id: tempId });
      forgetPdf(tempId); // don't pin megabytes in the pdf.js cache for a 320px preview
      if (!thumb || cancelled) return;
      await updateLibraryThumb(missing.key, thumb);
      refreshLibrary();
    })();
    return () => {
      cancelled = true;
    };
  }, [active, library, refreshLibrary]);

  /**
   * Clears the workspace, NOT the library. Restart is for "I'm done with this document", and the
   * whole point of the library is that it outlives that — otherwise the one button people press
   * by reflex would throw away every result they paid for.
   *
   * File the work FIRST. The library entry is written when a run finishes, so everything paid for
   * afterwards — a whole figure sweep — reaches it only through this save. Restarting without it
   * is exactly the reflex click that used to drop hours of redraws.
   */
  const reset = useCallback(async () => {
    await saveProgress().catch(() => false);
    docs.forEach((d) => forgetPdf(d.id));
    setDocs([]);
    setActiveId(null);
    setConfig(DEFAULT_CONFIG);
    setSelected(null);
    setHovered(null);
    setPage(1);
    setZoom(1);
    setFitWidth(true);
    setDirty(false);
    void clearSession();
  }, [docs, saveProgress]);

  const updateConfig = useCallback((patch: Partial<OcrConfig>) => {
    setConfig((prev) => ({ ...prev, ...patch }));
    setDirty(true);
  }, []);

  /**
   * Open an épure and LINK the two panes to it: select the figure, move the scan to the figure's
   * page, and switch the result pane to the Épure tab. This is the single entry point for "see
   * this in 3D" — a page's ⬗ link, a Convert figure row, or the tab's own figure index all route
   * here, so the reconstruction, the scan, and the picker can never point at different pages.
   */
  const openEpure = useCallback(
    (key: string) => {
      setEpure(key);
      const fig = active ? epureFiguresFor(active).find((f) => f.key === key) : undefined;
      if (fig) setPage(fig.pageIndex + 1);
      setTab('epure');
    },
    [active],
  );

  // Clicking a drawing in the scan while Épure is open selects the 3D bound to THAT drawing.
  // Resolve only at click time: a previous source selection must not pull the user back when they
  // deliberately choose another figure from the catalog afterwards.
  const selectSource = useCallback((next: Selection | null) => {
    setSelected(next);
    if (tab !== 'epure' || !active || !next) return;
    const sourcePage = active.result?.pages.find((entry) => entry.index === next.pageIndex);
    if (!sourcePage) return;
    const matches = epureFiguresForSourceBlock(active, next.pageIndex, next.blockId, sourcePage.blocks);
    if (!matches.length || matches.some((figure) => figure.key === epure)) return;
    setEpure(matches[0].key);
  }, [active, epure, tab]);


  // Every suspect span across the document, in reading order. The dom ids match what the Text tab
  // renders because both sides call the same `buildPageMarks` — so nav can scroll straight to a mark.
  const suspectList = useMemo(() => {
    const out: { pageIndex: number; domId: string }[] = [];
    for (const p of active?.result?.pages ?? [])
      buildPageMarks(p).forEach((_, i) => out.push({ pageIndex: p.index, domId: `sus-${p.index}-${i}` }));
    return out;
  }, [active?.result]);

  // Switching documents starts the walk over.
  useEffect(() => setSuspectCursor(-1), [activeId]);

  // Land on the current suspect: the marks only exist in the Text tab, so scrolling the <mark> into
  // view lets the pane's own scroll-spy update the page (and the viewer follows). A brief flash marks
  // where we landed. The <mark> is inside dangerouslySetInnerHTML, so touching its class is safe —
  // React won't rewrite that node unless its html changes, which nav does not do.
  useEffect(() => {
    const target = suspectCursor >= 0 ? suspectList[suspectCursor] : undefined;
    if (!target) return;
    const el = document.getElementById(target.domId);
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.classList.add('nav-focus');
    const t = window.setTimeout(() => el.classList.remove('nav-focus'), 1400);
    return () => window.clearTimeout(t);
  }, [suspectCursor, suspectList]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // A contenteditable surface (the Edit tab) is a DIV, so the tagName check alone would let `n`,
      // `f` and the arrows hijack the page while someone is typing a sentence into it.
      const target = e.target as HTMLElement;
      const typing =
        ['INPUT', 'TEXTAREA', 'SELECT'].includes(target?.tagName) || Boolean(target?.closest?.('[contenteditable]'));

      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        void run();
        return;
      }
      if (typing || e.metaKey || e.ctrlKey) return;

      const pageCount = active?.pageCount ?? 1;
      if (e.key === 'ArrowRight' || e.key === 'PageDown') setPage((p) => Math.min(pageCount, p + 1));
      else if (e.key === 'ArrowLeft' || e.key === 'PageUp') setPage((p) => Math.max(1, p - 1));
      else if (e.key === '+' || e.key === '=') { setFitWidth(false); setZoom((z) => Math.min(4, z + 0.1)); }
      else if (e.key === '-') { setFitWidth(false); setZoom((z) => Math.max(0.25, z - 0.1)); }
      else if (e.key === 'f') setFitWidth((f) => !f);
      else if (e.key === 'n' || e.key === 'N') {
        if (!suspectList.length) return;
        const dir = e.key === 'N' ? -1 : 1;
        setTab('text'); // marks only render here; make sure the target exists before we scroll to it
        setSuspectCursor((c) => (c < 0 ? (dir > 0 ? 0 : suspectList.length - 1) : (c + dir + suspectList.length) % suspectList.length));
      } else if (e.key === 'Escape') setSelected(null);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [run, active?.pageCount, suspectList.length]);

  return (
    <div className="app">
      <TopBar
        view={active ? 'doc' : 'home'}
        onHome={goHome}
        onAddFiles={() => fileInput.current?.click()}
        onCode={() => setCodeOpen(true)}
        onReset={reset}
        onConfigure={() => setConfigOpen((o) => !o)}
        onRun={() => void run()}
        onForceRun={() => void run(true)}
        onDownloadAll={() => void downloadAll(docs, config.tableMode)}
        configOpen={configOpen}
        canRun={Boolean(active) && !active?.running}
        running={Boolean(active?.running)}
        dirty={dirty && Boolean(active?.result)}
        hasResults={docs.some((d) => d.result)}
        canForce={Boolean(active?.result)}
      />

      <input
        ref={fileInput}
        type="file"
        accept="application/pdf,image/*"
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files) void addFiles(e.target.files);
          e.target.value = '';
        }}
      />

      {keyMissing && (
        <div className="banner">
          The OCR service is not configured. Copy <code>.env.example</code> to <code>.env</code>, add the
          server-side OCR key, and restart.
        </div>
      )}

      {editSaveError && (
        <div className="banner warn">
          A correction could not be saved to disk ({editSaveError}). It is still in this browser — but it
          will not survive clearing site data until the server is reachable.
          <button className="btn tiny" onClick={() => setEditSaveError(null)}>dismiss</button>
        </div>
      )}

      {/* Everything paid for since the last good save — a figure sweep is hours of it — exists only
          in this tab while this shows. Loud, and not dismissible into silence: the export is the
          way out, so it is offered right here. */}
      {saveError && (
        <div className="banner">
          <strong>This workspace is not being saved</strong> ({saveError}). Your redraws and corrections are
          only in this tab — closing it would lose them. Storage is usually full: delete a document from the
          home screen, or save the book now.
          <button className="btn tiny" onClick={() => void exportHtml(active ?? docs[0])} disabled={!docs.some((d) => d.result)}>
            ⤓ Save the book
          </button>
          <button className="btn tiny" onClick={() => void saveProgress()}>retry</button>
        </div>
      )}

      {configOpen && (
        <ConfigPanel config={config} onChange={updateConfig} onClose={() => setConfigOpen(false)} />
      )}

      {codeOpen && <CodeModal config={config} doc={active} onClose={() => setCodeOpen(false)} />}

      {!active ? (
        <Home
          library={library}
          sessionDocs={docs}
          editStats={editStats}
          cacheStats={cacheStats}
          onFiles={addFiles}
          onBrowse={() => fileInput.current?.click()}
          onOpen={(key) => void openFromLibrary(key)}
          onDelete={(key) => void removeFromLibrary(key)}
          onResume={(id) => {
            setActiveId(id);
            setPage(1);
            setSelected(null);
          }}
        />
      ) : (
        <>
          <DocBar
            docs={docs}
            active={active}
            pages={config.pages}
            flash={flash}
            onSelect={(id) => {
              setActiveId(id);
              setPage(1);
              setSelected(null);
            }}
          />
          <main className="panes">
            <Viewer
              doc={active}
              ocrPages={active.result?.pages ?? []}
              page={page}
              pageCount={active.pageCount}
              zoom={zoom}
              fitWidth={fitWidth}
              showBoxes={config.boundingBoxes}
              keepHeader={config.extractHeader}
              keepFooter={config.extractFooter}
              hovered={hovered}
              selected={selected}
              onHover={setHovered}
              onSelect={selectSource}
              onPage={setPage}
              onZoom={(z) => { setFitWidth(false); setZoom(z); }}
              onFitWidth={() => setFitWidth((f) => !f)}
              restorePage={restorePage}
            />
            <ResultPane
              doc={active}
              tab={tab}
              onTab={setTab}
              pages={active.result?.pages ?? []}
              page={page}
              onPage={setPage}
              config={config}
              hovered={hovered}
              selected={selected}
              onHover={setHovered}
              onSelect={setSelected}
              onRedraw={(pageIndex, blockId, patch) => patchBlock(active.id, pageIndex, blockId, patch)}
              onVision={(pageIndex, patch) => patchPage(active.id, pageIndex, patch)}
              onEdit={(pageIndex, patch) => editPage(active.id, pageIndex, patch)}
              onSaveProgress={saveProgress}
              savedAt={savedAt}
              restorePage={restorePage}
              epure={epure}
              onEpure={openEpure}
            />
          </main>
        </>
      )}
    </div>
  );
}
