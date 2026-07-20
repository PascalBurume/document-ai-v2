import { useEffect, useRef, useState } from 'react';
import {
  IconCode,
  IconDoc,
  IconDownload,
  IconEllipsis,
  IconPlay,
  IconPlus,
  IconRefresh,
  IconRotate,
  IconSliders,
} from './icons';

interface Props {
  /** Home shows only what makes sense with no document; doc view gets the full set. */
  view: 'home' | 'doc';
  onHome: () => void;
  onAddFiles: () => void;
  onCode: () => void;
  onReset: () => void;
  onConfigure: () => void;
  onRun: () => void;
  onForceRun: () => void;
  onDownloadAll: () => void;
  configOpen: boolean;
  canRun: boolean;
  running: boolean;
  dirty: boolean;
  hasResults: boolean;
  canForce: boolean;
}

export function TopBar(props: Props) {
  const home = props.view === 'home';

  return (
    <header className="topbar">
      {/* The brand is the way back: it returns to home (the library) without touching the
          workspace. Restart — which DOES clear the workspace — lives in the overflow menu. */}
      <button
        className="brand"
        onClick={props.onHome}
        disabled={home}
        title={home ? undefined : 'Home — processed documents'}
      >
        <span className="brand-mark">
          <IconDoc />
        </span>
        <h1>Document AI</h1>
      </button>

      <div className="spacer" />

      {/* The secondary actions live in one scrollable group, and Run is pinned OUTSIDE it. The bar
          used to wrap: add one button too many and Run — the primary action, the one bound to
          ⌘/Ctrl+Enter — dropped onto a second row under the title, which reads as broken. A header
          that reflows its primary action out from under the cursor is worse than one that scrolls. */}
      <div className="actions">
        {home ? (
          <>
            <button
              className={`btn${props.configOpen ? ' on' : ''}`}
              onClick={props.onConfigure}
              aria-pressed={props.configOpen}
            >
              <IconSliders /> Configure
            </button>
            <button className="btn primary" onClick={props.onAddFiles}>
              <IconPlus /> Add files
            </button>
          </>
        ) : (
          <>
            <button className="btn" onClick={props.onAddFiles}>
              <IconPlus /> Add files
            </button>
            <button
              className={`btn${props.configOpen ? ' on' : ''}`}
              onClick={props.onConfigure}
              aria-pressed={props.configOpen}
            >
              <IconSliders /> Configure
            </button>
            <button className="btn" onClick={props.onDownloadAll} disabled={!props.hasResults}>
              <IconDownload /> Download all
            </button>
          </>
        )}
      </div>

      {/* Outside the scrollable group: an absolutely-positioned dropdown inside overflow-x: auto
          gets clipped by it, and the rare-actions menu should never scroll out of reach anyway. */}
      {!home && <OverflowMenu {...props} />}

      {!home && (
        <button className="btn primary run" onClick={props.onRun} disabled={!props.canRun} title="⌘/Ctrl + Enter">
          <IconPlay /> {props.running ? 'Running…' : props.dirty ? 'Re-run' : 'Run'}
        </button>
      )}
    </header>
  );
}

/** Rare and destructive actions, one level down so they can't be hit by reflex. */
function OverflowMenu(props: Props) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const pick = (action: () => void) => () => {
    setOpen(false);
    action();
  };

  return (
    <div className="menu-wrap" ref={wrap}>
      <button
        className={`btn${open ? ' on' : ''}`}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="More actions"
        title="More actions"
      >
        <IconEllipsis />
      </button>
      {open && (
        <div className="menu" role="menu">
          <button className="menu-item" role="menuitem" onClick={pick(props.onCode)}>
            <IconCode /> Code
          </button>
          {/* Paying twice for the same pages is the whole thing we are avoiding, so a billed
              re-run is a separate, deliberate action — never the one you hit by reflex. */}
          {props.canForce && (
            <button
              className="menu-item danger"
              role="menuitem"
              onClick={pick(props.onForceRun)}
              disabled={!props.canRun}
              title="Ignore the cache and send this document to the OCR service again. This is billed."
            >
              <IconRefresh /> Force re-run
            </button>
          )}
          <div className="menu-sep" />
          <button
            className="menu-item danger"
            role="menuitem"
            onClick={pick(props.onReset)}
            title="Close every open document and reset the config. The processed-documents library is kept."
          >
            <IconRotate /> Restart
          </button>
        </div>
      )}
    </div>
  );
}
