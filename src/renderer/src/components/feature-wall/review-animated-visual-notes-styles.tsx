import type { JSX } from 'react'

// Why: Notes-page-specific CSS lives here so the imperative loop in
// ReviewNotesAnimatedVisual can flip a small set of stateful classes without
// going through React reconciliation. Split from the Ship-page styles purely
// to keep each file under the per-file line-length lint cap.
export function ReviewNotesVisualStyles(): JSX.Element {
  return (
    <style>{`
      .ravs-window {
        position: absolute;
        inset: 0;
        --ravs-soft-surface: color-mix(in srgb, var(--foreground) 2%, var(--card));
        --ravs-soft-fill: color-mix(in srgb, var(--foreground) 6%, transparent);
        --ravs-panel-border: color-mix(in srgb, var(--foreground) 18%, var(--border));
        --ravs-emphasis-border: color-mix(in srgb, var(--foreground) 44%, var(--border));
        --ravs-floating-shadow: 0 14px 30px rgb(0 0 0 / 0.22), 0 2px 6px rgb(0 0 0 / 0.12);
        background: var(--card);
        border: 1px solid var(--border);
        border-radius: 10px;
        overflow: hidden;
        display: flex;
        flex-direction: column;
        box-shadow: 0 1px 2px rgb(0 0 0 / 0.08);
      }
      .ravs-difftoolbar {
        display: flex; align-items: center; gap: 8px;
        padding: 6px 10px;
        border-bottom: 1px solid var(--border);
        background: var(--ravs-soft-surface);
        font-size: 11px;
        color: var(--muted-foreground);
      }
      .ravs-diff-path {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        color: var(--foreground);
      }
      .ravs-ai-chip {
        margin-left: auto;
        display: inline-flex;
        align-items: stretch;
        overflow: hidden;
        border-radius: 6px;
        border: 1px solid var(--border);
        background: var(--ravs-soft-surface);
        opacity: 0;
        transform: translateY(-2px);
        transition: opacity 320ms ease, transform 320ms ease;
      }
      .ravs-ai-chip.is-visible { opacity: 1; transform: none; }
      .ravs-ai-chip .ravs-count-btn,
      .ravs-ai-chip .ravs-send-btn {
        display: inline-flex; align-items: center; gap: 5px;
        padding: 3px 8px;
        font-size: 11px;
        color: var(--muted-foreground);
        background: transparent;
        line-height: 1;
      }
      .ravs-ai-chip .ravs-count-btn { border-right: 1px solid var(--border); }
      .ravs-ai-chip .ravs-send-btn {
        padding: 3px 7px;
        position: relative;
      }
      .ravs-send-glow {
        position: absolute; inset: 0;
        background: rgba(34, 197, 94, 0.18);
        opacity: 0;
        transition: opacity 280ms ease;
        pointer-events: none;
      }
      .ravs-ai-chip .ravs-send-btn.is-flash .ravs-send-glow { opacity: 1; }
      .ravs-count-num {
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        color: var(--foreground);
        font-weight: 600;
      }
      .ravs-diffbody {
        flex: 1; min-height: 0;
        position: relative;
        background: var(--editor-surface, var(--card));
      }
      .ravs-diffscroll {
        position: absolute; inset: 0;
        overflow: hidden;
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 11.5px;
        line-height: 1.55;
        color: var(--foreground);
        padding: 4px 0 8px;
        transition: opacity 240ms ease;
      }
      .ravs-diffscroll.is-hidden { opacity: 0; pointer-events: none; }
      .ravs-term {
        position: absolute; inset: 0;
        background: var(--editor-surface, var(--card));
        color: var(--foreground);
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 11px;
        line-height: 1.45;
        overflow: hidden;
        display: flex;
        flex-direction: column;
        opacity: 0;
        pointer-events: none;
        transition: opacity 240ms ease;
        z-index: 4;
      }
      .ravs-term.is-visible { opacity: 1; }
      .ravs-term-body {
        flex: 1; min-height: 0;
        padding: 10px 12px;
        overflow: hidden;
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .ravs-term-line {
        white-space: pre-wrap;
        word-break: break-word;
        line-height: 1.45;
      }
      .ravs-term-muted { color: var(--muted-foreground); }
      .ravs-term-glyph { color: rgb(217 119 6); margin-right: 6px; }
      .ravs-term-check {
        color: rgb(16 185 129);
        font-weight: 700;
        margin-right: 6px;
      }
      .ravs-term-spinner {
        display: inline-block;
        width: 8px; height: 8px;
        margin-right: 6px;
        border-radius: 999px;
        border: 1.5px solid color-mix(in srgb, var(--foreground) 20%, transparent);
        border-top-color: var(--foreground);
        vertical-align: -1px;
        animation: ravs-term-spin 0.9s linear infinite;
      }
      @keyframes ravs-term-spin { to { transform: rotate(360deg) } }
      .ravs-hunk-header {
        display: grid;
        grid-template-columns: 36px 36px 16px minmax(0,1fr);
        align-items: center;
        padding: 1px 8px 1px 0;
        background: rgba(99, 102, 241, 0.06);
        color: var(--muted-foreground);
        font-size: 10.5px;
        border-top: 1px solid var(--border);
        border-bottom: 1px solid var(--border);
      }
      .ravs-hunk-header .ravs-text {
        grid-column: 4 / -1;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        color: rgb(99 102 241);
        font-size: 10.5px;
      }
      .ravs-diff-line {
        display: grid;
        grid-template-columns: 36px 36px 16px minmax(0,1fr);
        align-items: stretch;
        position: relative;
      }
      .ravs-ln {
        text-align: right;
        padding: 0 6px 0 0;
        color: var(--muted-foreground);
        font-size: 10.5px;
        user-select: none;
        opacity: 0.85;
      }
      .ravs-marker {
        text-align: center;
        color: var(--muted-foreground);
        font-weight: 700;
        opacity: 0.7;
      }
      .ravs-text-cell {
        padding-right: 8px;
        white-space: pre;
        overflow: hidden;
      }
      .ravs-tok-kw { color: #a855f7; }
      .ravs-tok-id { color: #2563eb; }
      .ravs-tok-str { color: #16a34a; }
      .ravs-diff-line.is-add {
        background: color-mix(in srgb, var(--git-decoration-added) 14%, transparent);
      }
      .ravs-diff-line.is-add .ravs-marker {
        color: color-mix(in srgb, var(--git-decoration-added) 72%, transparent);
        opacity: 1;
      }
      .ravs-diff-line.is-rem {
        background: color-mix(in srgb, var(--git-decoration-deleted) 14%, transparent);
      }
      .ravs-diff-line.is-rem .ravs-marker {
        color: color-mix(in srgb, var(--git-decoration-deleted) 72%, transparent);
        opacity: 1;
      }

      .ravs-add-note-btn {
        position: absolute;
        left: 4px;
        width: 18px; height: 18px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 0;
        border: 1px solid color-mix(in srgb, currentColor 22%, var(--border));
        border-radius: 4px;
        background: var(--ravs-soft-fill);
        color: var(--foreground);
        z-index: 5;
        opacity: 0;
        box-shadow: 0 1px 2px rgb(0 0 0 / 0.14);
        pointer-events: none;
        transition: opacity 160ms ease;
      }
      .ravs-add-note-btn.is-visible { opacity: 1; }

      .ravs-note-row {
        padding: 4px 8px 4px 0;
        max-height: 0;
        overflow: hidden;
        opacity: 0;
        transition:
          max-height 360ms cubic-bezier(.4,0,.2,1),
          opacity 280ms ease 60ms,
          padding 360ms cubic-bezier(.4,0,.2,1);
      }
      .ravs-note-row.is-visible { max-height: 90px; opacity: 1; }
      .ravs-note-card {
        margin: 0 12px;
        position: relative;
        border: 1px solid var(--ravs-panel-border);
        border-left: 3px solid var(--ravs-emphasis-border);
        border-radius: 6px;
        background-color: var(--card);
        padding: 5px 8px 5px 10px;
        box-shadow: 0 1px 2px rgb(0 0 0 / 0.16);
      }
      .ravs-note-meta {
        font-size: 9.5px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--muted-foreground);
      }
      .ravs-note-body {
        font-size: 11.5px;
        color: var(--foreground);
        line-height: 1.35;
        margin-top: 2px;
      }

      .ravs-popover {
        position: absolute;
        left: 12px;
        right: 12px;
        max-width: none;
        z-index: 20;
        padding: 8px 10px;
        border: 1px solid var(--ravs-panel-border);
        border-left: 3px solid var(--ravs-emphasis-border);
        border-radius: 6px;
        background-color: var(--card);
        color: var(--foreground);
        box-shadow: var(--ravs-floating-shadow);
        display: flex; flex-direction: column; gap: 6px;
        opacity: 0;
        transform: translateY(-4px) scale(0.985);
        pointer-events: none;
        transition: opacity 180ms ease, transform 180ms ease;
      }
      .ravs-popover.is-visible { opacity: 1; transform: none; pointer-events: auto; }
      .ravs-pop-label {
        font-size: 10px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--muted-foreground);
      }
      .ravs-pop-input {
        min-height: 38px;
        max-height: 80px;
        padding: 6px 8px;
        border: 1px solid var(--border);
        border-radius: 4px;
        background: var(--editor-surface, var(--card));
        font-size: 12px;
        line-height: 1.4;
        color: var(--foreground);
        white-space: pre-wrap;
        word-break: break-word;
        overflow: hidden;
      }
      .ravs-pop-footer {
        display: flex; justify-content: flex-end; gap: 6px;
      }
      .ravs-pop-btn {
        font-size: 11px;
        font-weight: 500;
        padding: 4px 9px;
        border-radius: 5px;
        line-height: 1;
        border: 1px solid transparent;
        display: inline-flex; align-items: center; gap: 5px;
      }
      .ravs-pop-btn.is-cancel {
        color: var(--muted-foreground);
        background: transparent;
      }
      .ravs-pop-btn.is-add {
        color: var(--primary-foreground);
        background: var(--primary);
      }

      .ravs-send-menu {
        position: absolute;
        z-index: 30;
        right: 8px;
        top: 6px;
        min-width: 200px;
        background: var(--popover);
        color: var(--popover-foreground);
        border: 1px solid var(--border);
        border-radius: 8px;
        padding: 4px;
        box-shadow: var(--ravs-floating-shadow);
        opacity: 0;
        transform: translateY(-4px) scale(0.985);
        pointer-events: none;
        transition: opacity 180ms ease, transform 180ms ease;
      }
      .ravs-send-menu.is-visible { opacity: 1; transform: none; pointer-events: auto; }
      .ravs-menu-section {
        padding: 4px 8px 2px;
        font-size: 9.5px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: var(--muted-foreground);
      }
      .ravs-menu-row {
        display: grid;
        grid-template-columns: 16px minmax(0,1fr);
        align-items: center;
        gap: 8px;
        padding: 6px 8px;
        border-radius: 5px;
        font-size: 12px;
        color: var(--popover-foreground);
      }
      .ravs-menu-row.is-hot {
        background: var(--accent);
        box-shadow: inset 0 0 0 1px var(--border);
      }

      .ravs-cursor {
        position: absolute;
        z-index: 40;
        pointer-events: none;
        transition: transform 600ms cubic-bezier(.45,.05,.2,1), opacity 200ms ease;
        transform: translate(-30px, 220px);
        opacity: 0;
      }
      .ravs-cursor.is-visible { opacity: 1; }
      .ravs-cursor .ravs-ripple {
        position: absolute;
        left: -6px; top: -6px;
        width: 28px; height: 28px;
        border-radius: 999px;
        border: 2px solid color-mix(in srgb, var(--foreground) 52%, transparent);
        opacity: 0;
      }
      .ravs-cursor.is-clicking .ravs-ripple {
        animation: ravs-ripple 460ms ease-out forwards;
      }
      @keyframes ravs-ripple {
        0% { transform: scale(0.4); opacity: 0.9; }
        100% { transform: scale(1.4); opacity: 0; }
      }
      .ravs-caret {
        display: inline-block;
        width: 1.5px;
        height: 1em;
        background: currentColor;
        vertical-align: -2px;
        margin-left: 1px;
        animation: ravs-caret-blink 1.05s steps(1) infinite;
      }
      @keyframes ravs-caret-blink { 0%, 50% { opacity: 1 } 51%, 100% { opacity: 0 } }
    `}</style>
  )
}
