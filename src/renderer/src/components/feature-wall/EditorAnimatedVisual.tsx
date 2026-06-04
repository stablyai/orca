/* eslint-disable max-lines -- Why: this animation is a self-contained storyboard; splitting the slash-menu DOM, toolbar SVGs, and timing constants into separate modules would obscure the sequence rather than clarify it. */
import { useEffect, useRef } from 'react'
import type { JSX, ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { getShortcutPlatform } from '@/hooks/useShortcutLabel'

// Why: the visual leans on direct DOM mutation (typing into a node, swapping
// classes, anchoring a floating menu by measured rect) so the loop reads
// like the HTML mock instead of fighting React's reconciliation.

const PRE_HOVER_MS = 450
const TYPE_PER_CHAR_MS = 60
const POST_TYPE_MS = 120
const MENU_HOLD_MS = 900
const CLICK_RIPPLE_MS = 220
const POST_CLICK_MS = 140
const POST_H1_REVEAL_MS = 260
const POST_H1_TYPE_MS = 700
const NEW_LINE_HOLD_MS = 380
const FINAL_HOLD_MS = 2200

const KBD_CLASS_DOC =
  'rounded border border-border bg-card px-1.5 py-0.5 font-mono text-[10.5px] text-muted-foreground'

function CursorIcon(): JSX.Element {
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 16 16"
      aria-hidden
      focusable="false"
      className="drop-shadow-[0_1px_1px_rgba(0,0,0,0.35)]"
    >
      <path
        d="M2 1.5 L2 12 L5 9 L7.2 14.5 L9.5 13.6 L7.3 8 L11.5 8 Z"
        fill="#fff"
        stroke="#18181b"
        strokeWidth={1}
        strokeLinejoin="round"
      />
    </svg>
  )
}

// Toolbar icons mirror RichMarkdownToolbar.tsx — same families so the
// surface reads as Orca's actual editor, not a generic editor.
const TB_ICON: Record<string, JSX.Element> = {
  pilcrow: (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M11 3H6.5a3 3 0 0 0 0 6H8" />
      <path d="M9 3v11" />
      <path d="M12 3v11" />
    </svg>
  ),
  h1: (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 4v8" />
      <path d="M9 4v8" />
      <path d="M3 8h6" />
      <path d="M12 6l1-1v7" />
    </svg>
  ),
  h2: (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 4v8" />
      <path d="M9 4v8" />
      <path d="M3 8h6" />
      <path d="M11 6.2A1.5 1.5 0 0 1 14 6.5c0 1.4-3 2-3 5.5h3" />
    </svg>
  ),
  h3: (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 4v8" />
      <path d="M9 4v8" />
      <path d="M3 8h6" />
      <path d="M11 6.2A1.5 1.5 0 0 1 14 6.5c0 1.5-3 1.5-3 1.5s3 0 3 2c0 1.4-2.5 1.7-3 1" />
    </svg>
  ),
  bold: (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M5 3h4a2.5 2.5 0 0 1 0 5H5z" />
      <path d="M5 8h4.5a2.5 2.5 0 0 1 0 5H5z" />
    </svg>
  ),
  italic: (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M10 3 6 13" />
      <path d="M5 3h5" />
      <path d="M6 13h5" />
    </svg>
  ),
  strike: (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 8h10" />
      <path d="M11 5a3 3 0 0 0-3-2H7a2.5 2.5 0 0 0-2.5 2.5C4.5 7 6 8 8 8" />
      <path d="M5.5 11A2.5 2.5 0 0 0 8 13h1a3 3 0 0 0 3-2.5" />
    </svg>
  ),
  list: (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx={3.5} cy={4} r={0.7} fill="currentColor" />
      <circle cx={3.5} cy={8} r={0.7} fill="currentColor" />
      <circle cx={3.5} cy={12} r={0.7} fill="currentColor" />
      <path d="M7 4h6" />
      <path d="M7 8h6" />
      <path d="M7 12h6" />
    </svg>
  ),
  olist: (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M2.5 3h1v2.5" />
      <path d="M2 8h2c0.5 0 0.5 1 0 1l-1.5 2H4" />
      <path d="M7 4h6" />
      <path d="M7 8h6" />
      <path d="M7 12h6" />
    </svg>
  ),
  check: (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x={2.5} y={2.5} width={11} height={11} rx={2} />
      <path d="m5.5 8 2 2 3-4" />
    </svg>
  ),
  quote: (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M5 4H3v3.5L5 9V6h2V4z" />
      <path d="M11 4h-2v3.5l2 1.5V6h2V4z" />
    </svg>
  ),
  code: (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m6 5-3 3 3 3" />
      <path d="m10 5 3 3-3 3" />
    </svg>
  ),
  copy: (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x={5} y={5} width={8} height={8} rx={1.4} />
      <path d="M3 11V4a1 1 0 0 1 1-1h7" />
    </svg>
  )
}

function ToolbarBtn(props: { iconKey: keyof typeof TB_ICON }): JSX.Element {
  return (
    <span className="inline-flex size-[22px] items-center justify-center rounded text-muted-foreground">
      <span className="size-[13px] [&>svg]:size-full">{TB_ICON[props.iconKey]}</span>
    </span>
  )
}

function ToolbarSep(): JSX.Element {
  return <span className="mx-1 h-3.5 w-px bg-foreground/10" />
}

// Slash menu row — visible always; the active row gets the highlight
// background, mirroring RichMarkdownSlashMenu.tsx.
function SlashRow(props: {
  refCb?: (el: HTMLDivElement | null) => void
  iconKey: keyof typeof TB_ICON
  label: string
  shortcut: string
  hidden?: boolean
}): JSX.Element {
  return (
    <div
      ref={props.refCb}
      data-slash-row
      className={cn(
        'grid h-6 grid-cols-[18px_1fr_auto] items-center gap-2 rounded-[5px] px-2 py-1 pl-1.5',
        props.hidden ? 'hidden' : null
      )}
    >
      <span className="inline-flex items-center justify-center text-muted-foreground [&>svg]:size-[13px]">
        {TB_ICON[props.iconKey]}
      </span>
      <span className="whitespace-nowrap leading-none">{props.label}</span>
      <span className="font-mono text-[10.5px] text-muted-foreground">{props.shortcut}</span>
    </div>
  )
}

export function EditorAnimatedVisual(props: { reducedMotion: boolean }): JSX.Element {
  const { reducedMotion } = props
  const editorShortcutPrefix = getShortcutPlatform() === 'darwin' ? '⌘' : 'Ctrl+'
  const boldShortcutLabel = `${editorShortcutPrefix}B`
  const italicShortcutLabel = `${editorShortcutPrefix}I`

  const docRef = useRef<HTMLDivElement | null>(null)
  const activeLineRef = useRef<HTMLDivElement | null>(null)
  const activeTextRef = useRef<HTMLSpanElement | null>(null)
  const afterRef = useRef<HTMLDivElement | null>(null)
  const cursorRef = useRef<HTMLDivElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const rowH1Ref = useRef<HTMLDivElement | null>(null)
  const rowCodeRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (reducedMotion) {
      return
    }
    const docMaybe = docRef.current
    const activeLineInitial = activeLineRef.current
    const cursorMaybe = cursorRef.current
    const menuMaybe = menuRef.current
    const afterMaybe = afterRef.current
    if (!docMaybe || !activeLineInitial || !cursorMaybe || !menuMaybe || !afterMaybe) {
      return
    }
    // Re-bind to non-null locals so the helper closures spanning `await`
    // points keep their narrowed types — TS flow analysis drops the narrow
    // through async boundaries otherwise.
    const doc: HTMLDivElement = docMaybe
    const cursor: HTMLDivElement = cursorMaybe
    const menu: HTMLDivElement = menuMaybe
    const after: HTMLDivElement = afterMaybe

    let cancelled = false
    const timers: number[] = []
    const wait = (ms: number): Promise<void> =>
      new Promise((resolve) => {
        const id = window.setTimeout(() => resolve(), ms)
        timers.push(id)
      })

    // Stash initial DOM so we can restore between loops.
    const initialActiveLineHTML = activeLineInitial.outerHTML
    const initialActiveLineParent = activeLineInitial.parentNode
    const initialActiveLineNextSibling = activeLineInitial.nextSibling

    let activeLine: HTMLDivElement = activeLineInitial
    let activeText: HTMLSpanElement | null = activeTextRef.current
    let activeCaret: HTMLSpanElement | null =
      activeLineInitial.querySelector<HTMLSpanElement>('[data-md-caret]')

    function setSlashMode(mode: 'all' | 'code'): void {
      menu.querySelectorAll<HTMLElement>('[data-slash-show]').forEach((el) => {
        const allowed = (el.getAttribute('data-slash-show') ?? '').split(',')
        el.style.display = allowed.includes(mode) ? '' : 'none'
      })
    }

    function placeMenuNearLine(line: HTMLElement): void {
      const docRect = doc.getBoundingClientRect()
      const lineRect = line.getBoundingClientRect()
      // Why: nudge the menu right so it doesn't cover the "/" the user just
      // typed — keeps the typed character visible alongside the menu.
      const x = lineRect.left - docRect.left + 16
      menu.style.left = `${x}px`
      menu.style.top = '0px'
      const wasShown = menu.dataset.shown === '1'
      if (!wasShown) {
        menu.style.visibility = 'hidden'
        menu.dataset.shown = '1'
        menu.style.opacity = '1'
        menu.style.transform = 'none'
      }
      const menuH = menu.getBoundingClientRect().height
      if (!wasShown) {
        menu.dataset.shown = ''
        menu.style.opacity = ''
        menu.style.transform = ''
        menu.style.visibility = ''
      }
      const belowY = lineRect.bottom - docRect.top + 6
      const aboveY = lineRect.top - docRect.top - menuH - 6
      const docH = docRect.height
      const fitsBelow = belowY + menuH <= docH - 4
      menu.style.top = `${fitsBelow ? belowY : Math.max(4, aboveY)}px`
    }

    function moveCursorTo(targetEl: HTMLElement, offsetX = 0, offsetY = 0): void {
      const docRect = doc.getBoundingClientRect()
      const tRect = targetEl.getBoundingClientRect()
      const x = tRect.left - docRect.left + offsetX
      const y = tRect.top - docRect.top + offsetY
      cursor.style.transform = `translate(${x}px, ${y}px)`
    }

    function showMenu(): void {
      menu.dataset.shown = '1'
      menu.style.opacity = '1'
      menu.style.transform = 'translateY(0) scale(1)'
    }
    function hideMenu(): void {
      menu.dataset.shown = ''
      menu.style.opacity = '0'
      menu.style.transform = 'translateY(-4px) scale(0.985)'
    }
    function clearActiveRow(): void {
      menu
        .querySelectorAll<HTMLElement>('[data-slash-row]')
        .forEach((el) => el.classList.remove('slash-active'))
    }

    async function typeInto(
      el: HTMLElement,
      text: string,
      perChar = TYPE_PER_CHAR_MS
    ): Promise<void> {
      for (const ch of text) {
        if (cancelled) {
          return
        }
        el.textContent = (el.textContent ?? '') + ch
        await wait(perChar)
      }
    }

    function clearAfter(): void {
      after.innerHTML = ''
    }

    function restoreInitialActiveLine(): void {
      // Pull whatever the active line currently is back into the original
      // shape so the next loop starts from the same DOM as render.
      activeLine.remove()
      const wrapper = document.createElement('div')
      wrapper.innerHTML = initialActiveLineHTML
      const fresh = wrapper.firstElementChild as HTMLDivElement | null
      if (!fresh) {
        return
      }
      if (initialActiveLineParent) {
        if (
          initialActiveLineNextSibling &&
          initialActiveLineNextSibling.parentNode === initialActiveLineParent
        ) {
          initialActiveLineParent.insertBefore(fresh, initialActiveLineNextSibling)
        } else {
          initialActiveLineParent.appendChild(fresh)
        }
      }
      activeLine = fresh
      activeText = fresh.querySelector<HTMLSpanElement>('[data-md-active-text]')
      activeCaret = fresh.querySelector<HTMLSpanElement>('[data-md-caret]')
    }

    async function loop(): Promise<void> {
      while (!cancelled) {
        // Reset state.
        clearAfter()
        hideMenu()
        clearActiveRow()
        cursor.style.transition = 'none'
        cursor.style.opacity = '0'
        cursor.style.transform = 'translate(-30px, 80px)'
        // Force reflow so the next transition takes effect.
        void cursor.offsetWidth
        cursor.style.transition = ''
        await wait(PRE_HOVER_MS)
        if (cancelled) {
          return
        }

        // 1. Type "/" on the fresh active line.
        if (activeText) {
          activeText.textContent = ''
        }
        await typeInto(activeText ?? activeLine, '/')
        if (cancelled) {
          return
        }
        await wait(POST_TYPE_MS)
        if (cancelled) {
          return
        }

        // 2. Slash menu opens, anchored near the line.
        setSlashMode('all')
        placeMenuNearLine(activeLine)
        showMenu()
        cursor.style.opacity = '1'
        const rowH1 = rowH1Ref.current
        if (rowH1) {
          moveCursorTo(rowH1, 14, 11)
          rowH1.classList.add('slash-active')
        }
        await wait(MENU_HOLD_MS)
        if (cancelled) {
          return
        }

        // 3. Click — line becomes an H1.
        cursor.dataset.clicking = '1'
        await wait(CLICK_RIPPLE_MS)
        if (cancelled) {
          return
        }
        cursor.dataset.clicking = ''
        hideMenu()
        cursor.style.opacity = '0'
        await wait(POST_CLICK_MS)
        if (cancelled) {
          return
        }

        // Convert the active line to an H1: clear the slash glyph, drop the
        // monospace styling, type the heading.
        activeLine.dataset.role = 'h1'
        if (activeText) {
          activeText.textContent = ''
        }
        if (activeCaret) {
          activeCaret.style.display = ''
        }
        await wait(POST_H1_REVEAL_MS)
        if (cancelled) {
          return
        }
        await typeInto(activeText ?? activeLine, 'Ship checklist', 55)
        if (cancelled) {
          return
        }
        await wait(POST_H1_TYPE_MS)
        if (cancelled) {
          return
        }

        // 4. New active line below the H1 — user types "/code".
        const newActive = document.createElement('div')
        newActive.dataset.role = 'active'
        newActive.className = activeLineClass()
        const newText = document.createElement('span')
        newText.dataset.mdActiveText = '1'
        const newCaret = document.createElement('span')
        newCaret.dataset.mdCaret = '1'
        newCaret.className = caretClass()
        newActive.appendChild(newText)
        newActive.appendChild(newCaret)
        after.appendChild(newActive)
        const lineForBeat2 = newActive
        await wait(NEW_LINE_HOLD_MS)
        if (cancelled) {
          return
        }

        for (const ch of '/code') {
          if (cancelled) {
            return
          }
          newText.textContent = (newText.textContent ?? '') + ch
          await wait(TYPE_PER_CHAR_MS)
        }
        await wait(POST_TYPE_MS)
        if (cancelled) {
          return
        }

        // Filter to the Code Block row, anchor menu, highlight.
        clearActiveRow()
        if (rowH1) {
          rowH1.classList.remove('slash-active')
        }
        setSlashMode('code')
        placeMenuNearLine(lineForBeat2)
        showMenu()
        cursor.style.opacity = '1'
        const rowCode = rowCodeRef.current
        if (rowCode) {
          moveCursorTo(rowCode, 14, 11)
          rowCode.classList.add('slash-active')
        }
        await wait(MENU_HOLD_MS)
        if (cancelled) {
          return
        }

        // 5. Click — line becomes a code block.
        cursor.dataset.clicking = '1'
        await wait(CLICK_RIPPLE_MS)
        if (cancelled) {
          return
        }
        cursor.dataset.clicking = ''
        hideMenu()
        cursor.style.opacity = '0'
        await wait(POST_CLICK_MS)
        if (cancelled) {
          return
        }

        const codeBlock = document.createElement('div')
        codeBlock.className = 'mt-1.5 animate-[md-block-in_380ms_cubic-bezier(.2,.8,.2,1)_both]'
        codeBlock.innerHTML = codeBlockHTML()
        lineForBeat2.replaceWith(codeBlock)

        await wait(FINAL_HOLD_MS)
        if (cancelled) {
          return
        }

        // Restore the initial DOM and loop.
        restoreInitialActiveLine()
      }
    }

    void loop()
    return () => {
      cancelled = true
      timers.forEach((id) => window.clearTimeout(id))
    }
  }, [reducedMotion])

  return (
    <div className="relative overflow-visible rounded-xl border border-border bg-card text-foreground shadow-[0_1px_2px_rgba(24,24,27,0.04)]">
      {/* Faux titlebar with the editing path so the surface reads as a
          real document, not a generic notes widget. */}
      <div className="flex h-7 items-center gap-1.5 border-b border-border bg-muted/40 px-3">
        <span className="size-2.5 rounded-full bg-rose-400/70" />
        <span className="size-2.5 rounded-full bg-amber-400/70" />
        <span className="size-2.5 rounded-full bg-emerald-400/70" />
        <span className="ml-2 font-mono text-[11px] text-muted-foreground">
          notes / launch-plan.md
        </span>
      </div>

      {/* Toolbar — visual-only, mirrors RichMarkdownToolbar.tsx button order. */}
      <div className="flex items-center gap-0.5 border-b border-border bg-muted/30 px-2 py-1.5">
        <ToolbarBtn iconKey="pilcrow" />
        <ToolbarBtn iconKey="h1" />
        <ToolbarBtn iconKey="h2" />
        <ToolbarBtn iconKey="h3" />
        <ToolbarSep />
        <ToolbarBtn iconKey="bold" />
        <ToolbarBtn iconKey="italic" />
        <ToolbarBtn iconKey="strike" />
        <ToolbarSep />
        <ToolbarBtn iconKey="list" />
        <ToolbarBtn iconKey="olist" />
        <ToolbarBtn iconKey="check" />
        <ToolbarBtn iconKey="quote" />
        <span className="ml-auto inline-flex items-center gap-1.5 font-mono text-[10px] text-muted-foreground">
          <span className="size-1.5 rounded-full bg-emerald-500" />
          <span>autosaved</span>
        </span>
      </div>

      {/* Document surface. Height is driven by the modal's right-column
          width, so we leave it intrinsic and rely on the inner layout. */}
      <div
        ref={docRef}
        className="relative overflow-hidden bg-background px-6 pb-5 pt-4"
        style={{ minHeight: 280 }}
      >
        <DocTitle>Launch plan</DocTitle>

        <DocBlock>
          A quick note for the team — pulling together what&apos;s left before we ship.
        </DocBlock>

        <DocBlock listItem>Smoke-test the install flow on a fresh machine.</DocBlock>
        <DocBlock listItem>Update the docs index once the new tile lands.</DocBlock>

        {/* Active line where the slash menu fires. The animation imperatively
            mutates this node — typing a glyph, swapping role to h1, etc. */}
        <ActiveLine activeLineRef={activeLineRef} activeTextRef={activeTextRef} />

        <div ref={afterRef} />

        {/* Slash menu, absolutely-positioned and anchored at runtime. */}
        <div
          ref={menuRef}
          data-slash-menu
          className="pointer-events-none absolute z-10 min-w-[220px] origin-top-left rounded-lg border border-border bg-card p-1.5 text-[12px] shadow-[0_16px_38px_rgba(24,24,27,0.18),0_2px_6px_rgba(24,24,27,0.08)] transition-[opacity,transform] duration-[160ms] ease-out"
          style={{
            opacity: 0,
            transform: 'translateY(-4px) scale(0.985)'
          }}
        >
          <div
            data-slash-show="all"
            className="px-2 pb-1 pt-1.5 text-[9.5px] font-bold uppercase tracking-[0.06em] text-muted-foreground"
          >
            Headings
          </div>
          <SlashRow
            refCb={(el) => {
              rowH1Ref.current = el
            }}
            iconKey="h1"
            label="Heading 1"
            shortcut="#"
          />
          <SlashRow iconKey="h2" label="Heading 2" shortcut="##" />
          <div data-slash-show="all" className="my-1 h-px bg-foreground/[0.08]" />
          <div
            data-slash-show="all"
            className="px-2 pb-1 pt-1.5 text-[9.5px] font-bold uppercase tracking-[0.06em] text-muted-foreground"
          >
            Basic blocks
          </div>
          <SlashRow iconKey="quote" label="Quote" shortcut=">" />
          <SlashRow iconKey="list" label="Bullet List" shortcut="-" />
          <SlashRow
            refCb={(el) => {
              rowCodeRef.current = el
            }}
            iconKey="code"
            label="Code Block"
            shortcut="```"
          />
        </div>

        {/* Fake cursor — the loop translates it onto the highlighted slash row
            and triggers the click ripple. */}
        <div
          ref={cursorRef}
          aria-hidden
          className="pointer-events-none absolute left-0 top-0 z-20 transition-[opacity,transform] duration-[600ms] ease-[cubic-bezier(.45,.05,.2,1)]"
          style={{ opacity: 0 }}
        >
          <div className="relative">
            <CursorIcon />
            <span
              data-cursor-ripple
              className="pointer-events-none absolute -left-1.5 -top-1.5 size-7 rounded-full border-2 border-foreground/50"
              style={{ opacity: 0 }}
            />
          </div>
        </div>
      </div>

      {/* Standalone keyboard hint below the visual — same chip pattern as
          WorkbenchAnimatedVisual so the workbench sub-steps share a footer
          shape. */}
      <div className="border-t border-border bg-card px-3 py-2 text-[11px] text-muted-foreground">
        Type <kbd className={KBD_CLASS_DOC}>/</kbd> for blocks ·{' '}
        <kbd className={KBD_CLASS_DOC}>{boldShortcutLabel}</kbd> bold ·{' '}
        <kbd className={KBD_CLASS_DOC}>{italicShortcutLabel}</kbd> italic
      </div>

      {/* Why: the imperative loop adds .slash-active and toggles
          [data-cursor-ripple] state via [data-clicking]. We pin those
          presentation rules here instead of TS so the React tree stays
          declarative. */}
      <style>{`
        [data-slash-menu] [data-slash-row].slash-active {
          background: rgba(24,24,27,0.07);
          box-shadow: inset 0 0 0 1px rgba(24,24,27,0.06);
        }
        [data-md-active-line][data-role="active"] {
          color: rgb(113 113 122);
          font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
          font-size: 12.5px;
        }
        [data-md-active-line][data-role="h1"] {
          color: inherit;
          font-family: inherit;
          font-size: 18px;
          font-weight: 700;
          letter-spacing: -0.01em;
          line-height: 1.2;
          margin-top: 6px;
        }
        [data-md-caret] {
          display: inline-block;
          width: 1.5px;
          height: 1em;
          background: currentColor;
          vertical-align: -2px;
          margin-left: 1px;
          animation: md-caret-blink 1.05s steps(1) infinite;
        }
        @keyframes md-caret-blink {
          0%, 50% { opacity: 1 }
          51%, 100% { opacity: 0 }
        }
        @keyframes md-block-in {
          from { opacity: 0; transform: translateY(-2px); }
          to   { opacity: 1; transform: none; }
        }
        @keyframes md-cursor-ripple {
          0%   { transform: scale(0.4); opacity: 0.9; }
          100% { transform: scale(1.4); opacity: 0; }
        }
        [data-clicking="1"] [data-cursor-ripple] {
          animation: md-cursor-ripple 460ms ease-out forwards;
        }
      `}</style>
    </div>
  )
}

function DocTitle(props: { children: ReactNode }): JSX.Element {
  return (
    <div className="mb-2.5 text-[22px] font-bold leading-[1.15] tracking-[-0.01em]">
      {props.children}
    </div>
  )
}

function DocBlock(props: { children: ReactNode; listItem?: boolean }): JSX.Element {
  if (props.listItem) {
    return (
      <div className="relative mt-1.5 min-h-[18px] py-px pl-[18px] text-[13px] leading-[1.55]">
        <span className="absolute left-1.5 top-[9px] size-1 rounded-full bg-foreground/55" />
        {props.children}
      </div>
    )
  }
  return (
    <div className="mt-1.5 min-h-[18px] py-px text-[13px] leading-[1.55]">{props.children}</div>
  )
}

function ActiveLine(props: {
  activeLineRef: React.RefObject<HTMLDivElement | null>
  activeTextRef: React.RefObject<HTMLSpanElement | null>
}): JSX.Element {
  return (
    <div
      ref={props.activeLineRef}
      data-md-active-line
      data-role="active"
      className={activeLineClass()}
    >
      <span ref={props.activeTextRef} data-md-active-text="1" />
      <span data-md-caret="1" className={caretClass()} />
    </div>
  )
}

// Helpers shared between initial render and re-created beat-2 lines so the
// styling stays in lockstep regardless of which path mounts the node.
function activeLineClass(): string {
  return 'relative mt-1.5 min-h-[18px] py-px'
}
function caretClass(): string {
  return 'inline-block'
}

function codeBlockHTML(): string {
  return `
    <div style="background: rgba(24,24,27,0.04); border: 1px solid rgba(24,24,27,0.10); border-radius: 8px; overflow: hidden; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; line-height: 1.55;">
      <div style="display: flex; align-items: center; justify-content: space-between; padding: 5px 9px; border-bottom: 1px solid rgba(24,24,27,0.10); background: rgba(24,24,27,0.04);">
        <span style="font-size: 10px; font-weight: 600; color: rgb(113 113 122); letter-spacing: 0.02em;">typescript</span>
        <span style="display: inline-flex; align-items: center; gap: 4px; font-size: 9.5px; color: rgb(113 113 122);">
          <svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="5" width="8" height="8" rx="1.4"/><path d="M3 11V4a1 1 0 0 1 1-1h7"/></svg>
          <span>Copy</span>
        </span>
      </div>
      <div style="padding: 8px 11px; background: #fff; display: flex; flex-direction: column; gap: 2px;">
        <div><span style="color:#a855f7;">await</span> <span style="color:#2563eb;">runSmokeTests</span><span style="color:rgb(113 113 122);">({</span> env<span style="color:rgb(113 113 122);">:</span> <span style="color:#16a34a;">'staging'</span> <span style="color:rgb(113 113 122);">})</span></div>
        <div><span style="color:#a855f7;">await</span> <span style="color:#2563eb;">publish</span><span style="color:rgb(113 113 122);">({</span> tag<span style="color:rgb(113 113 122);">:</span> <span style="color:#16a34a;">'v0.4.0'</span> <span style="color:rgb(113 113 122);">})</span></div>
      </div>
    </div>`
}
