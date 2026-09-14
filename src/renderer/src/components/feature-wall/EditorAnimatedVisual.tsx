import { useRef } from 'react'
import type { JSX, ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { getShortcutPlatform } from '@/hooks/useShortcutLabel'
import { translate } from '@/i18n/i18n'
import { TB_ICON, ToolbarBtn, ToolbarSep } from './editor-animated-toolbar-icons'
import { activeLineClass, caretClass } from './editor-animated-visual-markup'
import { useEditorAnimatedVisualAnimation } from './use-editor-animated-visual-animation'

// Why: the visual leans on direct DOM mutation (typing into a node, swapping
// classes, anchoring a floating menu by measured rect) so the loop reads
// like the HTML mock instead of fighting React's reconciliation.

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
  useEditorAnimatedVisualAnimation(reducedMotion, {
    docRef,
    activeLineRef,
    activeTextRef,
    afterRef,
    cursorRef,
    menuRef,
    rowH1Ref,
    rowCodeRef
  })

  return (
    <div className="relative overflow-visible rounded-xl border border-border bg-card text-foreground shadow-[0_1px_2px_rgba(24,24,27,0.04)]">
      {/* Faux titlebar with the editing path so the surface reads as a
          real document, not a generic notes widget. */}
      <div className="flex h-7 items-center gap-1.5 border-b border-border bg-muted/40 px-3">
        <span className="size-2.5 rounded-full bg-rose-400/70" />
        <span className="size-2.5 rounded-full bg-amber-400/70" />
        <span className="size-2.5 rounded-full bg-emerald-400/70" />
        <span className="ml-2 font-mono text-[11px] text-muted-foreground">
          {translate(
            'auto.components.feature.wall.EditorAnimatedVisual.cda56c5915',
            'notes / launch-plan.md'
          )}
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
          <span>
            {translate('auto.components.feature.wall.EditorAnimatedVisual.218503f9f3', 'autosaved')}
          </span>
        </span>
      </div>

      {/* Document surface. Height is driven by the modal's right-column
          width, so we leave it intrinsic and rely on the inner layout. */}
      <div
        ref={docRef}
        className="relative overflow-hidden bg-background px-6 pb-5 pt-4"
        style={{ minHeight: 280 }}
      >
        <DocTitle>
          {translate('auto.components.feature.wall.EditorAnimatedVisual.5a55c00a81', 'Launch plan')}
        </DocTitle>

        <DocBlock>
          {translate(
            'auto.components.feature.wall.EditorAnimatedVisual.22ae7b4d9d',
            "A quick note for the team — pulling together what's left before we ship."
          )}
        </DocBlock>

        <DocBlock listItem>
          {translate(
            'auto.components.feature.wall.EditorAnimatedVisual.95f0c3a46f',
            'Smoke-test the install flow on a fresh machine.'
          )}
        </DocBlock>
        <DocBlock listItem>
          {translate(
            'auto.components.feature.wall.EditorAnimatedVisual.4426aab46f',
            'Update the docs index once the new tile lands.'
          )}
        </DocBlock>

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
            {translate('auto.components.feature.wall.EditorAnimatedVisual.1fb29ad710', 'Headings')}
          </div>
          <SlashRow
            refCb={(el) => {
              rowH1Ref.current = el
            }}
            iconKey="h1"
            label={translate(
              'auto.components.feature.wall.EditorAnimatedVisual.722170663a',
              'Heading 1'
            )}
            shortcut="#"
          />
          <SlashRow
            iconKey="h2"
            label={translate(
              'auto.components.feature.wall.EditorAnimatedVisual.a26a68d30c',
              'Heading 2'
            )}
            shortcut="##"
          />
          <div data-slash-show="all" className="my-1 h-px bg-foreground/[0.08]" />
          <div
            data-slash-show="all"
            className="px-2 pb-1 pt-1.5 text-[9.5px] font-bold uppercase tracking-[0.06em] text-muted-foreground"
          >
            {translate(
              'auto.components.feature.wall.EditorAnimatedVisual.abbdeea15d',
              'Basic blocks'
            )}
          </div>
          <SlashRow
            iconKey="quote"
            label={translate(
              'auto.components.feature.wall.EditorAnimatedVisual.f25687c588',
              'Quote'
            )}
            shortcut=">"
          />
          <SlashRow
            iconKey="list"
            label={translate(
              'auto.components.feature.wall.EditorAnimatedVisual.37fa4948ce',
              'Bullet List'
            )}
            shortcut="-"
          />
          <SlashRow
            refCb={(el) => {
              rowCodeRef.current = el
            }}
            iconKey="code"
            label={translate(
              'auto.components.feature.wall.EditorAnimatedVisual.8268b2376b',
              'Code Block'
            )}
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
        {translate('auto.components.feature.wall.EditorAnimatedVisual.3fe42a1da0', 'Type')}
        <kbd className={KBD_CLASS_DOC}>/</kbd>{' '}
        {translate('auto.components.feature.wall.EditorAnimatedVisual.8341391520', 'for blocks ·')}{' '}
        <kbd className={KBD_CLASS_DOC}>{boldShortcutLabel}</kbd>{' '}
        {translate('auto.components.feature.wall.EditorAnimatedVisual.8521536429', 'bold ·')}{' '}
        <kbd className={KBD_CLASS_DOC}>{italicShortcutLabel}</kbd>{' '}
        {translate('auto.components.feature.wall.EditorAnimatedVisual.7a763daf2f', 'italic')}
      </div>

      {/* Why: the imperative loop adds .slash-active and toggles
          [data-cursor-ripple] state via [data-clicking]. We pin those
          presentation rules here instead of TS so the React tree stays
          declarative. */}
      <style>
        {translate(
          'auto.components.feature.wall.EditorAnimatedVisual.e16479c1c5',
          '[data-slash-menu] [data-slash-row].slash-active { background: rgba(24,24,27,0.07); box-shadow: inset 0 0 0 1px rgba(24,24,27,0.06); } [data-md-active-line][data-role="active"] { color: rgb(113 113 122); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; } [data-md-active-line][data-role="h1"] { color: inherit; font-family: inherit; font-size: 18px; font-weight: 700; letter-spacing: -0.01em; line-height: 1.2; margin-top: 6px; } [data-md-caret] { display: inline-block; width: 1.5px; height: 1em; background: currentColor; vertical-align: -2px; margin-left: 1px; animation: md-caret-blink 1.05s steps(1) infinite; } @keyframes md-caret-blink { 0%, 50% { opacity: 1 } 51%, 100% { opacity: 0 } } @keyframes md-block-in { from { opacity: 0; transform: translateY(-2px); } to { opacity: 1; transform: none; } } @keyframes md-cursor-ripple { 0% { transform: scale(0.4); opacity: 0.9; } 100% { transform: scale(1.4); opacity: 0; } } [data-clicking="1"] [data-cursor-ripple] { animation: md-cursor-ripple 460ms ease-out forwards; }'
        )}
      </style>
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
