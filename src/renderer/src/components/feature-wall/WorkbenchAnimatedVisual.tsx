/* eslint-disable max-lines -- Why: this animation is a self-contained storyboard; splitting the phase markup from its timing constants would make the sequence harder to verify. */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import { cn } from '@/lib/utils'
import { useShortcutLabel } from '@/hooks/useShortcutLabel'
import { FeatureWallClickRing } from './FeatureWallClickRing'

// Why: the right-click menu needs the same icons as the real Orca menu so the
// visual reads as the actual product, not a generic terminal mockup.
function SplitRightIcon(): JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      width={12}
      height={12}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      aria-hidden
    >
      <rect x={2.5} y={3} width={11} height={10} rx={1.4} />
      <path d="M8 3v10" />
    </svg>
  )
}

function SplitDownIcon(): JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      width={12}
      height={12}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      aria-hidden
    >
      <rect x={2.5} y={3} width={11} height={10} rx={1.4} />
      <path d="M2.5 8h11" />
    </svg>
  )
}

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

const RUN_QUEUE: readonly { name: string; desc: string }[] = [
  { name: 'dashboard.spec.ts', desc: '› renders metrics' },
  { name: 'profile.spec.ts', desc: '› updates avatar' },
  { name: 'invoices.spec.ts', desc: '› exports CSV' },
  { name: 'settings.spec.ts', desc: '› toggles dark mode' }
]

type Phase =
  // Initial state: cursor parked off-canvas, no menu, no split.
  | { kind: 'idle' }
  // Cursor has entered the left pane and is hovering the prompt area.
  | { kind: 'hover' }
  // Right-click ripple is playing.
  | { kind: 'right-click' }
  // Context menu is open, no row highlighted yet.
  | { kind: 'menu-open' }
  // Cursor is parked on the highlighted "Split Terminal Right" row.
  | { kind: 'menu-active' }
  // Click ripple on the menu row.
  | { kind: 'menu-click' }
  // Pane has split; right pane is empty.
  | { kind: 'split-empty' }
  // Right pane is showing live progress (typing / thinking / response).
  | { kind: 'split-active' }

type RightLine =
  | { kind: 'session-started' }
  | { kind: 'submitted-prompt'; text: string }
  | { kind: 'thinking' }
  | { kind: 'response-skeleton'; widthPct: number; withGlyph: boolean }

type CursorTarget = { kind: 'hidden' } | { kind: 'pane' } | { kind: 'split-row' }

const KBD_CLASS =
  'rounded border border-border bg-card px-1.5 py-0.5 font-mono text-[11.5px] text-foreground'

// Beat timings — kept in named constants so the loop reads top-to-bottom.
const PRE_HOVER_MS = 450
const HOVER_HOLD_MS = 820
const RIGHT_CLICK_MS = 220
const MENU_SETTLE_MS = 380
const MENU_HOLD_MS = 1420
const MENU_CLICK_MS = 180
const POST_CLICK_MS = 160
const POST_SPLIT_MS = 700
const TYPE_PER_CHAR_MS = 95
const POST_CLAUDE_TYPE_MS = 550
const SESSION_HEADER_MS = 900
const PRE_PROMPT_TYPE_MS = 350
const PROMPT_PER_CHAR_MS = 55
const POST_PROMPT_TYPE_MS = 700
const POST_SUBMIT_MS = 450
const THINKING_MS = 1100
const RESPONSE_GAP_MS = 500
const RESPONSE_GAP_LATER_MS = 550
const FINAL_HOLD_MS = 1800

const RUN_TICK_MS = 2400

const CLAUDE_CMD = 'claude'
const REVIEW_PROMPT = 'review src/auth for missing error handling'
const RESPONSE_WIDTHS = [72, 88, 64, 78] as const

export function WorkbenchAnimatedVisual(props: { reducedMotion: boolean }): JSX.Element {
  const { reducedMotion } = props
  const splitRightShortcutLabel = useShortcutLabel('terminal.splitRight')
  const splitDownShortcutLabel = useShortcutLabel('terminal.splitDown')
  const panelRef = useRef<HTMLDivElement | null>(null)
  const leftPaneRef = useRef<HTMLDivElement | null>(null)
  const splitRowRef = useRef<HTMLDivElement | null>(null)

  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const [runIdx, setRunIdx] = useState(0)
  const [cursorTarget, setCursorTarget] = useState<CursorTarget>({ kind: 'hidden' })
  const [rightTyped, setRightTyped] = useState('')
  const [rightLines, setRightLines] = useState<readonly RightLine[]>([])
  const [showInputLine, setShowInputLine] = useState(true)
  const [promptGlyph, setPromptGlyph] = useState<'$' | '>'>('$')
  const [showCaret, setShowCaret] = useState(true)
  const [rippleKey, setRippleKey] = useState(0)

  // Cycle the running test on the left, independent of the loop, so the
  // playwright run keeps moving while the user works on the right.
  useEffect(() => {
    if (reducedMotion) {
      return
    }
    const id = window.setInterval(() => {
      setRunIdx((i) => (i + 1) % RUN_QUEUE.length)
    }, RUN_TICK_MS)
    return () => window.clearInterval(id)
  }, [reducedMotion])

  // Main animation loop — async-ish using setTimeout chains so reduced-motion
  // can short-circuit the entire effect cleanly.
  useEffect(() => {
    if (reducedMotion) {
      setPhase({ kind: 'idle' })
      setCursorTarget({ kind: 'hidden' })
      return
    }
    let cancelled = false
    const timeouts: number[] = []
    const wait = (ms: number): Promise<void> =>
      new Promise((resolve) => {
        const id = window.setTimeout(() => resolve(), ms)
        timeouts.push(id)
      })

    async function loop(): Promise<void> {
      while (!cancelled) {
        // 1. Reset state for a fresh cycle.
        setPhase({ kind: 'idle' })
        setCursorTarget({ kind: 'hidden' })
        setRightTyped('')
        setRightLines([])
        setShowInputLine(true)
        setPromptGlyph('$')
        setShowCaret(true)
        await wait(PRE_HOVER_MS)
        if (cancelled) {
          return
        }

        // 2. Cursor enters the left pane.
        setPhase({ kind: 'hover' })
        setCursorTarget({ kind: 'pane' })
        await wait(HOVER_HOLD_MS)
        if (cancelled) {
          return
        }

        // 3. Right-click ripple, then menu opens.
        setPhase({ kind: 'right-click' })
        setRippleKey((k) => k + 1)
        await wait(RIGHT_CLICK_MS)
        if (cancelled) {
          return
        }
        setPhase({ kind: 'menu-open' })
        await wait(MENU_SETTLE_MS)
        if (cancelled) {
          return
        }

        // 4. Cursor parks on the highlighted Split Terminal Right row.
        setPhase({ kind: 'menu-active' })
        setCursorTarget({ kind: 'split-row' })
        await wait(MENU_HOLD_MS)
        if (cancelled) {
          return
        }

        // 5. Click ripple, menu fades, pane splits.
        setPhase({ kind: 'menu-click' })
        setRippleKey((k) => k + 1)
        await wait(MENU_CLICK_MS)
        if (cancelled) {
          return
        }
        setCursorTarget({ kind: 'hidden' })
        await wait(POST_CLICK_MS)
        if (cancelled) {
          return
        }
        setPhase({ kind: 'split-empty' })
        await wait(POST_SPLIT_MS)
        if (cancelled) {
          return
        }

        // 6. User types `claude` into the new pane.
        setPhase({ kind: 'split-active' })
        for (let i = 1; i <= CLAUDE_CMD.length; i += 1) {
          if (cancelled) {
            return
          }
          setRightTyped(CLAUDE_CMD.slice(0, i))
          await wait(TYPE_PER_CHAR_MS)
        }
        await wait(POST_CLAUDE_TYPE_MS)
        if (cancelled) {
          return
        }

        // 7. Hide input line, show "session started", then bring input back
        //    with the Claude `>` prompt glyph.
        setShowInputLine(false)
        setRightLines((lines) => [...lines, { kind: 'session-started' }])
        await wait(SESSION_HEADER_MS)
        if (cancelled) {
          return
        }
        setShowInputLine(true)
        setPromptGlyph('>')
        setRightTyped('')
        await wait(PRE_PROMPT_TYPE_MS)
        if (cancelled) {
          return
        }

        // 8. Type the review prompt.
        for (let i = 1; i <= REVIEW_PROMPT.length; i += 1) {
          if (cancelled) {
            return
          }
          setRightTyped(REVIEW_PROMPT.slice(0, i))
          await wait(PROMPT_PER_CHAR_MS)
        }
        await wait(POST_PROMPT_TYPE_MS)
        if (cancelled) {
          return
        }

        // 9. Submit: collapse input into scrollback, swap to thinking spinner.
        setShowCaret(false)
        setRightLines((lines) => [...lines, { kind: 'submitted-prompt', text: REVIEW_PROMPT }])
        setShowInputLine(false)
        await wait(POST_SUBMIT_MS)
        if (cancelled) {
          return
        }
        setRightLines((lines) => [...lines, { kind: 'thinking' }])
        await wait(THINKING_MS)
        if (cancelled) {
          return
        }

        // 10. Stream skeleton response bars — actual answer doesn't matter.
        setRightLines((lines) => {
          const withoutThinking = lines.filter((l) => l.kind !== 'thinking')
          return [
            ...withoutThinking,
            { kind: 'response-skeleton', widthPct: RESPONSE_WIDTHS[0], withGlyph: true }
          ]
        })
        await wait(RESPONSE_GAP_MS)
        if (cancelled) {
          return
        }
        setRightLines((lines) => [
          ...lines,
          { kind: 'response-skeleton', widthPct: RESPONSE_WIDTHS[1], withGlyph: false }
        ])
        await wait(RESPONSE_GAP_LATER_MS)
        if (cancelled) {
          return
        }
        setRightLines((lines) => [
          ...lines,
          { kind: 'response-skeleton', widthPct: RESPONSE_WIDTHS[2], withGlyph: false }
        ])
        await wait(RESPONSE_GAP_LATER_MS)
        if (cancelled) {
          return
        }
        setRightLines((lines) => [
          ...lines,
          { kind: 'response-skeleton', widthPct: RESPONSE_WIDTHS[3], withGlyph: false }
        ])
        await wait(FINAL_HOLD_MS)
        if (cancelled) {
          return
        }
      }
    }

    loop()
    return () => {
      cancelled = true
      timeouts.forEach((id) => window.clearTimeout(id))
    }
  }, [reducedMotion])

  const cursor = useFakeCursor(panelRef, leftPaneRef, splitRowRef, cursorTarget, reducedMotion)

  const splitOpen =
    phase.kind === 'menu-click' || phase.kind === 'split-empty' || phase.kind === 'split-active'
  const menuShown =
    phase.kind === 'menu-open' || phase.kind === 'menu-active' || phase.kind === 'menu-click'
  const splitRowActive = phase.kind === 'menu-active' || phase.kind === 'menu-click'
  const showRipple = phase.kind === 'right-click' || phase.kind === 'menu-click'
  const running = RUN_QUEUE[runIdx] ?? RUN_QUEUE[0]

  return (
    <div
      ref={panelRef}
      className="relative overflow-hidden rounded-xl border border-border bg-card text-foreground shadow-[0_1px_2px_rgba(24,24,27,0.04)]"
    >
      {/* Faux titlebar — three traffic lights, nothing else. */}
      <div className="flex h-7 items-center gap-1.5 border-b border-border bg-muted/40 px-3">
        <span className="size-2.5 rounded-full bg-rose-400/70" />
        <span className="size-2.5 rounded-full bg-amber-400/70" />
        <span className="size-2.5 rounded-full bg-emerald-400/70" />
      </div>

      <div
        className={cn(
          'grid bg-[#fafafa] font-mono text-[11px] transition-[grid-template-columns] duration-[600ms] ease-[cubic-bezier(.2,.8,.2,1)]',
          splitOpen ? 'grid-cols-[1fr_1fr]' : 'grid-cols-[1fr_0fr]'
        )}
        style={{ minHeight: 230 }}
      >
        {/* Left pane: playwright list reporter. */}
        <div ref={leftPaneRef} className="relative flex min-w-0 flex-col gap-1.5 px-3 py-2.5">
          <TermLine>
            <Prompt>$</Prompt>
            <span className="text-foreground">pnpm playwright test</span>
          </TermLine>
          <TermLine muted>Running 12 tests using 4 workers</TermLine>
          <TermLine>
            <PwCheck />
            <PwIdx>1</PwIdx>login.spec.ts<PwName> › can sign in</PwName>
            <PwDur>(1.2s)</PwDur>
          </TermLine>
          <TermLine>
            <PwCheck />
            <PwIdx>2</PwIdx>checkout.spec.ts<PwName> › cart total updates</PwName>
            <PwDur>(0.8s)</PwDur>
          </TermLine>
          <TermLine>
            <RunSpinner />
            <PwIdx>3</PwIdx>
            {running.name}
            <PwName> {running.desc}</PwName>
          </TermLine>

          {/* Right-click context menu — light card, skeleton bars for the
              other items, real labels only for the two split actions. */}
          <ContextMenu
            shown={menuShown}
            splitRowActive={splitRowActive}
            splitRowRef={splitRowRef}
            splitRightShortcutLabel={splitRightShortcutLabel}
            splitDownShortcutLabel={splitDownShortcutLabel}
          />
        </div>

        {/* Right pane: empty until the split lands, then a Claude session. */}
        <div
          className={cn(
            'flex min-w-0 flex-col gap-1.5 overflow-hidden border-l border-border px-3 py-2.5 transition-[opacity,transform] duration-[480ms] ease-[cubic-bezier(.2,.8,.2,1)]',
            splitOpen ? 'opacity-100' : 'translate-x-2 opacity-0'
          )}
          style={{ transitionDelay: splitOpen ? '200ms' : '0ms' }}
        >
          <RightPaneScrollback lines={rightLines} />
          {showInputLine ? (
            <TermLine wrap>
              <Prompt claude={promptGlyph === '>'}>{promptGlyph}</Prompt>
              <span className="text-foreground">{rightTyped}</span>
              {showCaret ? (
                <span className="ml-px inline-block h-[11px] w-[5px] -translate-y-px animate-pulse bg-foreground align-[-1px]" />
              ) : null}
            </TermLine>
          ) : null}
        </div>
      </div>

      {/* Fake cursor overlay — moves between the pane prompt and the
          highlighted split-row inside the menu. */}
      <div
        aria-hidden
        className={cn(
          'pointer-events-none absolute left-0 top-0 z-20 transition-[opacity,transform] duration-700 ease-[cubic-bezier(.45,.05,.2,1)]',
          cursor.visible ? 'opacity-100' : 'opacity-0'
        )}
        style={{ transform: `translate(${cursor.x}px, ${cursor.y}px)` }}
      >
        <div className="relative">
          <CursorIcon />
          {showRipple ? <FeatureWallClickRing key={rippleKey} /> : null}
        </div>
      </div>

      {/* Standalone keyboard hint stays inside the visual so the tour copy can
          remain a single subheader line. */}
      <div className="border-t border-border bg-card px-3 py-2 text-[11px] text-muted-foreground">
        Same pane: <kbd className={KBD_CLASS}>{splitRightShortcutLabel}</kbd> splits right ·{' '}
        <kbd className={KBD_CLASS}>{splitDownShortcutLabel}</kbd> splits down
      </div>
    </div>
  )
}

function TermLine(props: {
  children: React.ReactNode
  muted?: boolean
  wrap?: boolean
}): JSX.Element {
  return (
    <div
      className={cn(
        'leading-[1.45]',
        props.muted ? 'text-muted-foreground' : null,
        props.wrap ? 'whitespace-pre-wrap break-words' : 'truncate whitespace-pre'
      )}
    >
      {props.children}
    </div>
  )
}

function Prompt(props: { children: React.ReactNode; claude?: boolean }): JSX.Element {
  return (
    <span className={cn('mr-1.5', props.claude ? 'text-amber-600' : 'text-emerald-600')}>
      {props.children}
    </span>
  )
}

function PwCheck(): JSX.Element {
  return <span className="mr-1.5 font-bold text-emerald-600">✓</span>
}

function PwIdx(props: { children: React.ReactNode }): JSX.Element {
  return <span className="mr-1.5 text-muted-foreground">{props.children}</span>
}

function PwName(props: { children: React.ReactNode }): JSX.Element {
  return <span className="text-muted-foreground">{props.children}</span>
}

function PwDur(props: { children: React.ReactNode }): JSX.Element {
  return <span className="ml-2 text-muted-foreground">{props.children}</span>
}

function RunSpinner(): JSX.Element {
  return (
    <span className="mr-1.5 inline-block size-2 animate-spin rounded-full border-[1.5px] border-foreground/20 border-t-foreground align-[-1px]" />
  )
}

function ContextMenu(props: {
  shown: boolean
  splitRowActive: boolean
  splitRowRef: React.RefObject<HTMLDivElement | null>
  splitRightShortcutLabel: string
  splitDownShortcutLabel: string
}): JSX.Element {
  return (
    <div
      className={cn(
        'absolute left-[110px] top-[78px] z-10 min-w-[218px] origin-top-left rounded-lg border border-border bg-card p-1.5 font-sans text-[12px] text-foreground shadow-[0_16px_38px_rgba(24,24,27,0.18),0_2px_6px_rgba(24,24,27,0.08)] transition-[opacity,transform] duration-[160ms] ease-out',
        props.shown ? 'opacity-100' : '-translate-y-[3px] scale-[0.985] opacity-0'
      )}
      style={{ pointerEvents: 'none' }}
    >
      <CtxSkeleton width={70} />
      <CtxSkeleton width={56} />
      <CtxSeparator />
      <div
        ref={props.splitRowRef}
        className={cn(
          'grid h-[22px] grid-cols-[18px_1fr_auto] items-center gap-2 rounded-[5px] px-1.5 py-1 pl-1.5',
          props.splitRowActive
            ? 'bg-foreground/[0.07] shadow-[inset_0_0_0_1px_rgba(24,24,27,0.06)]'
            : null
        )}
      >
        <span className="inline-flex items-center justify-center text-muted-foreground">
          <SplitRightIcon />
        </span>
        <span className="whitespace-nowrap leading-none">Split Terminal Right</span>
        <span className="font-mono text-[11px] text-muted-foreground">
          {props.splitRightShortcutLabel}
        </span>
      </div>
      <div className="grid h-[22px] grid-cols-[18px_1fr_auto] items-center gap-2 rounded-[5px] px-1.5 py-1 pl-1.5">
        <span className="inline-flex items-center justify-center text-muted-foreground">
          <SplitDownIcon />
        </span>
        <span className="whitespace-nowrap leading-none">Split Terminal Down</span>
        <span className="font-mono text-[11px] text-muted-foreground">
          {props.splitDownShortcutLabel}
        </span>
      </div>
      <CtxSeparator />
      <CtxSkeleton width={64} />
      <CtxSkeleton width={48} />
    </div>
  )
}

function CtxSkeleton(props: { width: number }): JSX.Element {
  return (
    <div className="flex h-[18px] items-center px-2.5">
      <span
        className="block h-1.5 rounded-[3px] bg-foreground/[0.16]"
        style={{ width: `${props.width}%` }}
      />
    </div>
  )
}

function CtxSeparator(): JSX.Element {
  return <div className="my-1 h-px bg-foreground/[0.08]" />
}

function RightPaneScrollback(props: { lines: readonly RightLine[] }): JSX.Element {
  return (
    <>
      {props.lines.map((line, i) => {
        if (line.kind === 'session-started') {
          return (
            <TermLine key={i} muted>
              <span className="mr-1.5 text-foreground">●</span>Claude Code session started
            </TermLine>
          )
        }
        if (line.kind === 'submitted-prompt') {
          return (
            <TermLine key={i} wrap>
              <span className="mr-1.5 text-amber-600">&gt;</span>
              {line.text}
            </TermLine>
          )
        }
        if (line.kind === 'thinking') {
          return (
            <TermLine key={i}>
              <RunSpinner />
              <span className="text-muted-foreground">Thinking…</span>
            </TermLine>
          )
        }
        return (
          <TermLine key={i}>
            {line.withGlyph ? <span className="mr-1.5 text-amber-600">●</span> : null}
            <span
              className="inline-block h-[7px] rounded-[3px] align-[1px]"
              style={{ width: `${line.widthPct}%`, background: 'rgba(24,24,27,0.18)' }}
            />
          </TermLine>
        )
      })}
    </>
  )
}

function useFakeCursor(
  panelRef: React.RefObject<HTMLDivElement | null>,
  leftPaneRef: React.RefObject<HTMLDivElement | null>,
  splitRowRef: React.RefObject<HTMLDivElement | null>,
  target: CursorTarget,
  reducedMotion: boolean
): { x: number; y: number; visible: boolean } {
  const [pos, setPos] = useState<{ x: number; y: number; visible: boolean }>({
    x: 0,
    y: 0,
    visible: false
  })

  // Why: rect math has to run after layout/commit so refs have measurable
  // boxes. useLayoutEffect avoids a frame of stale position.
  useLayoutEffect(() => {
    if (reducedMotion) {
      setPos((p) => ({ ...p, visible: false }))
      return
    }
    const panel = panelRef.current
    if (!panel) {
      return
    }
    if (target.kind === 'hidden') {
      setPos((p) => ({ ...p, visible: false }))
      return
    }
    const panelRect = panel.getBoundingClientRect()
    if (target.kind === 'pane') {
      const pane = leftPaneRef.current
      if (!pane) {
        return
      }
      const rect = pane.getBoundingClientRect()
      // Park near the prompt area — same offsets as the HTML mock.
      setPos({
        x: rect.left - panelRect.left + 90,
        y: rect.top - panelRect.top + 110,
        visible: true
      })
      return
    }
    const row = splitRowRef.current
    if (!row) {
      return
    }
    const rect = row.getBoundingClientRect()
    setPos({
      x: rect.left - panelRect.left + 12,
      y: rect.top - panelRect.top + 11,
      visible: true
    })
  }, [target, reducedMotion, panelRef, leftPaneRef, splitRowRef])

  return pos
}
