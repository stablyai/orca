/* eslint-disable max-lines -- Why: this animation is a self-contained storyboard; splitting the phase markup from its timing constants would make the sequence harder to verify. */
import { useEffect, useRef, useState, type JSX, type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { ClaudeIcon } from '@/components/status-bar/icons'
import { useShortcutLabel } from '@/hooks/useShortcutLabel'
import { FeatureWallClickRing } from './FeatureWallClickRing'

// Why: this animation tells the full Orca story end-to-end — the user opens a
// new browser tab, annotates a target on the pricing page, types a change,
// hands off to Claude in a split pane, and Claude edits + verifies the page.
// The DOM and timing track docs/feature-wall-workbench-tile-mock.html so the
// modal stays in lockstep with the design source.

const PROMPT_TEXT = 'Make Starter card stand out'

// Why: these hand-rolled tour popovers need the same dark-mode separation as
// Orca's dropdown/popover primitives while staying inside the storyboard DOM.
const TOUR_FLOATING_SURFACE_CLASS =
  'border border-black/14 bg-[rgba(255,255,255,0.82)] text-popover-foreground shadow-[0_16px_36px_rgba(0,0,0,0.24),inset_0_1px_0_rgba(255,255,255,0.14)] backdrop-blur-2xl dark:border-white/14 dark:bg-[rgba(0,0,0,0.72)] dark:shadow-[0_20px_44px_rgba(0,0,0,0.42),inset_0_1px_0_rgba(255,255,255,0.04)]'

const PRE_INTRO_MS = 600
const NEWTAB_APPROACH_MS = 700
const NEWTAB_CLICK_MS = 180
const NEWTAB_DWELL_MS = 700
const NEWTAB_ROW_HOVER_MS = 1050
const NEWTAB_ROW_CLICK_MS = 220
const TAB_REVEAL_MS = 500
const APPROACH_CARD_MS = 900
const INSPECT_MS = 700
const ANNOTATE_OPEN_MS = 360
const ANNOTATE_TYPE_INTERVAL_MS = 58
const ANNOTATE_HOLD_MS = 900
const SEND_APPROACH_MS = 500
const SEND_CLICK_MS = 250
const HANDOFF_MS = 200
const WORKING_LINE_STAGGER_MS = 260
const WORKING_HOLD_MS = 1400
const UPDATED_HOLD_MS = 900
const VERIFY_INTENT_MS = 1100
const CLICK_APPROACH_MS = 620
const CLICK_PRESS_MS = 280
const NAVIGATED_HOLD_MS = 700
const SCREENSHOT_LINE_HOLD_MS = 420
const SCREENSHOT_FLASH_HOLD_MS = 700
const VERIFIED_HOLD_MS = 2400
const RESET_HOLD_MS = 300
const CLICK_RING_MS = 460

type Phase =
  | 'idle'
  | 'newtab-approach'
  | 'newtab-click'
  | 'newtab-row-approach'
  | 'newtab-row-click'
  | 'tab-revealed'
  | 'approach-card'
  | 'inspect'
  | 'annotate'
  | 'send-approach'
  | 'send-click'
  | 'handoff'
  | 'working'
  | 'updated'
  | 'verify-intent'
  | 'click-approach'
  | 'click-press'
  | 'navigated'
  | 'screenshot-line'
  | 'screenshot-flash'
  | 'verified'

const PHASE_ORDER: readonly Phase[] = [
  'idle',
  'newtab-approach',
  'newtab-click',
  'newtab-row-approach',
  'newtab-row-click',
  'tab-revealed',
  'approach-card',
  'inspect',
  'annotate',
  'send-approach',
  'send-click',
  'handoff',
  'working',
  'updated',
  'verify-intent',
  'click-approach',
  'click-press',
  'navigated',
  'screenshot-line',
  'screenshot-flash',
  'verified'
]

function phaseAtLeast(current: Phase, target: Phase): boolean {
  return PHASE_ORDER.indexOf(current) >= PHASE_ORDER.indexOf(target)
}

const SPLIT_PHASES: readonly Phase[] = [
  'working',
  'updated',
  'verify-intent',
  'click-approach',
  'click-press',
  'navigated',
  'screenshot-line',
  'screenshot-flash',
  'verified'
]

function isSplitPhase(phase: Phase): boolean {
  return SPLIT_PHASES.includes(phase)
}

type TermEntry =
  | { kind: 'prompt'; text: string }
  | { kind: 'working' }
  | { kind: 'ok'; html: ReactNode }
  | { kind: 'tool'; tool: string; arg: string }
  | { kind: 'tool-muted'; tool: string; muted: string }

const TERM_ENTRIES: readonly { entry: TermEntry; minPhase: Phase }[] = [
  { entry: { kind: 'prompt', text: PROMPT_TEXT }, minPhase: 'working' },
  { entry: { kind: 'working' }, minPhase: 'working' },
  {
    entry: {
      kind: 'ok',
      html: (
        <>
          ✓ Updated{' '}
          <code className="text-emerald-600 dark:text-emerald-400">
            .pp-card[data-card=&quot;starter&quot;] .pp-cta
          </code>
        </>
      )
    },
    minPhase: 'updated'
  },
  {
    entry: {
      kind: 'prompt',
      text: 'Let me click Try free to verify it still works.'
    },
    minPhase: 'verify-intent'
  },
  { entry: { kind: 'tool', tool: 'click', arg: '"Try free"' }, minPhase: 'click-press' },
  {
    entry: { kind: 'tool-muted', tool: 'screenshot', muted: '(capturing page)' },
    minPhase: 'screenshot-line'
  },
  {
    entry: {
      kind: 'ok',
      html: <>✓ Verified — Try free still works.</>
    },
    minPhase: 'verified'
  }
]

export function BrowserAnimatedVisual(props: {
  reducedMotion: boolean
  onCycleComplete?: () => void
}): JSX.Element {
  const { reducedMotion, onCycleComplete } = props
  const newBrowserShortcutLabel = useShortcutLabel('tab.newBrowser')

  const [phase, setPhase] = useState<Phase>('idle')
  const [typedChars, setTypedChars] = useState(0)
  const [flashKey, setFlashKey] = useState(0)
  const [clickRingKey, setClickRingKey] = useState(0)
  const [clickRingVisible, setClickRingVisible] = useState(false)
  const [menuOffsetX, setMenuOffsetX] = useState(0)
  const [annotateAnchor, setAnnotateAnchor] = useState<{ left: number; top: number }>({
    left: 116,
    top: 70
  })

  const browserPageRef = useRef<HTMLDivElement | null>(null)
  const titlebarRef = useRef<HTMLDivElement | null>(null)
  const newtabBtnRef = useRef<HTMLSpanElement | null>(null)
  const newtabRowRef = useRef<HTMLDivElement | null>(null)
  const starterCardRef = useRef<HTMLDivElement | null>(null)
  const ctaRef = useRef<HTMLSpanElement | null>(null)
  const sendBtnRef = useRef<HTMLSpanElement | null>(null)
  const cursorPosRef = useRef<{ x: number; y: number }>({ x: 40, y: 18 })
  const [cursorPos, setCursorPos] = useState<{ x: number; y: number }>({ x: 40, y: 18 })

  // Why: cursor coordinates are computed against .browser-page so they survive
  // grid reflow when the split lands. We stash both a ref (synchronous read
  // for hover-then-click sequences) and state (for transition animation).
  function setCursorTo(x: number, y: number): void {
    cursorPosRef.current = { x, y }
    setCursorPos({ x, y })
  }

  function transformForElement(
    el: HTMLElement | null,
    offsetX = 0,
    offsetY = 0
  ): { x: number; y: number } {
    const page = browserPageRef.current
    if (!page || !el) {
      return cursorPosRef.current
    }
    const pageRect = page.getBoundingClientRect()
    const elRect = el.getBoundingClientRect()
    return {
      x: elRect.left - pageRect.left + elRect.width / 2 - 8 + offsetX,
      y: elRect.top - pageRect.top + elRect.height / 2 - 8 + offsetY
    }
  }

  /* oxlint-disable react-doctor/no-adjust-state-on-prop-change -- Why: this
     storyboard effect owns timed local animation state; deriving every phase
     during render would break measured cursor sequencing. */
  useEffect(() => {
    if (reducedMotion) {
      setPhase('verified')
      setTypedChars(PROMPT_TEXT.length)
      setClickRingVisible(false)
      return
    }
    let cancelled = false
    const timeouts: number[] = []
    const wait = (ms: number): Promise<void> =>
      new Promise((resolve) => {
        const id = window.setTimeout(() => resolve(), ms)
        timeouts.push(id)
      })
    function pulseClickRing(): void {
      setClickRingKey((key) => key + 1)
      setClickRingVisible(true)
      const id = window.setTimeout(() => {
        if (!cancelled) {
          setClickRingVisible(false)
        }
      }, CLICK_RING_MS)
      timeouts.push(id)
    }

    async function loop(): Promise<void> {
      while (!cancelled) {
        setPhase('idle')
        setTypedChars(0)
        setClickRingVisible(false)
        setCursorTo(40, 18)
        await wait(PRE_INTRO_MS)
        if (cancelled) {
          return
        }

        // 1. Cursor approaches the "+" in the tab strip.
        const newtabPos = transformForElement(newtabBtnRef.current)
        setCursorTo(newtabPos.x, newtabPos.y)
        setPhase('newtab-approach')
        await wait(NEWTAB_APPROACH_MS)
        if (cancelled) {
          return
        }

        // 2. Click "+". Capture the dropdown's left offset relative to the
        // titlebar so the menu lines up with the button.
        setPhase('newtab-click')
        pulseClickRing()
        if (titlebarRef.current && newtabBtnRef.current) {
          const tbRect = titlebarRef.current.getBoundingClientRect()
          const btnRect = newtabBtnRef.current.getBoundingClientRect()
          setMenuOffsetX(btnRect.left - tbRect.left)
        }
        await wait(NEWTAB_CLICK_MS)
        if (cancelled) {
          return
        }
        await wait(NEWTAB_DWELL_MS)
        if (cancelled) {
          return
        }

        // 3. Move to "New Browser Tab" row.
        const rowPos = transformForElement(newtabRowRef.current, 6, 0)
        setCursorTo(rowPos.x, rowPos.y)
        setPhase('newtab-row-approach')
        await wait(NEWTAB_ROW_HOVER_MS)
        if (cancelled) {
          return
        }

        // 4. Click → dropdown closes, browser tab reveals, page comes alive.
        setPhase('newtab-row-click')
        pulseClickRing()
        await wait(NEWTAB_ROW_CLICK_MS)
        if (cancelled) {
          return
        }
        setPhase('tab-revealed')
        await wait(TAB_REVEAL_MS)
        if (cancelled) {
          return
        }

        // Cursor approaches the Starter card.
        const starterPos = transformForElement(starterCardRef.current, 0, -8)
        setCursorTo(starterPos.x, starterPos.y)
        setPhase('approach-card')
        await wait(APPROACH_CARD_MS)
        if (cancelled) {
          return
        }

        setPhase('inspect')
        pulseClickRing()
        await wait(INSPECT_MS)
        if (cancelled) {
          return
        }

        // Anchor the annotate popover to the Starter card's actual position so
        // it lines up regardless of how the parent grid lays out.
        if (browserPageRef.current && starterCardRef.current) {
          const pageRect = browserPageRef.current.getBoundingClientRect()
          const cardRect = starterCardRef.current.getBoundingClientRect()
          setAnnotateAnchor({
            left: cardRect.right - pageRect.left + 6,
            top: cardRect.top - pageRect.top
          })
        }
        setPhase('annotate')
        await wait(ANNOTATE_OPEN_MS)
        if (cancelled) {
          return
        }
        for (let i = 1; i <= PROMPT_TEXT.length; i += 1) {
          if (cancelled) {
            return
          }
          setTypedChars(i)
          await wait(ANNOTATE_TYPE_INTERVAL_MS)
        }
        await wait(ANNOTATE_HOLD_MS)
        if (cancelled) {
          return
        }

        const sendPos = transformForElement(sendBtnRef.current)
        setCursorTo(sendPos.x, sendPos.y)
        setPhase('send-approach')
        await wait(SEND_APPROACH_MS)
        if (cancelled) {
          return
        }

        setPhase('send-click')
        pulseClickRing()
        await wait(SEND_CLICK_MS)
        if (cancelled) {
          return
        }

        setPhase('handoff')
        await wait(HANDOFF_MS)
        if (cancelled) {
          return
        }

        // Split lands. Working line + prompt are gated on phase >= 'working';
        // small stagger keeps them from popping in simultaneously.
        setPhase('working')
        await wait(WORKING_LINE_STAGGER_MS * 2)
        if (cancelled) {
          return
        }
        await wait(WORKING_HOLD_MS)
        if (cancelled) {
          return
        }

        setPhase('updated')
        await wait(UPDATED_HOLD_MS)
        if (cancelled) {
          return
        }

        setPhase('verify-intent')
        await wait(VERIFY_INTENT_MS)
        if (cancelled) {
          return
        }

        const ctaPos = transformForElement(ctaRef.current)
        setCursorTo(ctaPos.x, ctaPos.y)
        setPhase('click-approach')
        await wait(CLICK_APPROACH_MS)
        if (cancelled) {
          return
        }

        setPhase('click-press')
        pulseClickRing()
        await wait(CLICK_PRESS_MS)
        if (cancelled) {
          return
        }

        setPhase('navigated')
        await wait(NAVIGATED_HOLD_MS)
        if (cancelled) {
          return
        }

        setPhase('screenshot-line')
        await wait(SCREENSHOT_LINE_HOLD_MS)
        if (cancelled) {
          return
        }

        setPhase('screenshot-flash')
        setFlashKey((k) => k + 1)
        await wait(SCREENSHOT_FLASH_HOLD_MS)
        if (cancelled) {
          return
        }

        setPhase('verified')
        await wait(VERIFIED_HOLD_MS)
        if (cancelled) {
          return
        }
        onCycleComplete?.()

        await wait(RESET_HOLD_MS)
      }
    }

    loop()
    return () => {
      cancelled = true
      timeouts.forEach((id) => window.clearTimeout(id))
    }
  }, [onCycleComplete, reducedMotion])
  /* oxlint-enable react-doctor/no-adjust-state-on-prop-change */

  const isIntroPhase =
    phase === 'idle' ||
    phase === 'newtab-approach' ||
    phase === 'newtab-click' ||
    phase === 'newtab-row-approach' ||
    phase === 'newtab-row-click'
  const browserChromeVisible = !isIntroPhase
  const browserTabVisible = !isIntroPhase
  const terminalTabMinimized = !isIntroPhase
  const newtabActive = phase === 'newtab-click' || phase === 'newtab-row-approach'
  const newtabRowActive = phase === 'newtab-row-approach'
  const dropdownVisible =
    phase === 'newtab-click' || phase === 'newtab-row-approach' || phase === 'newtab-row-click'
  const cursorVisible = (phase !== 'idle' && phase !== 'navigated') || clickRingVisible
  const ringStarter =
    phase === 'inspect' ||
    phase === 'annotate' ||
    phase === 'send-approach' ||
    phase === 'send-click' ||
    phase === 'handoff'
  const annotateOpen = phase === 'annotate' || phase === 'send-approach' || phase === 'send-click'
  const sendPressed = phase === 'send-click'
  const isSplit = isSplitPhase(phase)
  const ctaHighlighted = phaseAtLeast(phase, 'updated')
  const ctaPressing = phase === 'click-press'
  const showSignup =
    phase === 'navigated' ||
    phase === 'screenshot-line' ||
    phase === 'screenshot-flash' ||
    phase === 'verified'
  const flashing = phase === 'screenshot-flash'
  // While the cursor is acting on the titlebar / dropdown, let the cursor
  // overflow the body's clipping bounds. Once the page is live we re-clip so
  // the cursor never escapes the browser body.
  const bodyOverflowVisible = isIntroPhase

  return (
    <div className="flex flex-col gap-2">
      <div className="relative w-full" style={{ height: 270 }}>
        <div
          className="absolute inset-0 grid transition-[grid-template-columns,gap] duration-500 ease-out"
          style={{
            gridTemplateColumns: isSplit ? '1fr 1fr' : '1fr 0fr',
            gap: isSplit ? 10 : 0
          }}
        >
          {/* Browser app-window — column 1 */}
          <div className="relative flex min-w-0 flex-col overflow-hidden rounded-xl border border-border bg-card text-card-foreground shadow-xs">
            <div
              ref={titlebarRef}
              className="relative flex min-h-[32px] items-end gap-1.5 border-b border-border bg-muted/40 px-2.5 pt-2"
            >
              <div className="ml-1 flex flex-1 items-end gap-1 overflow-visible">
                <BrowserTab
                  minimized={terminalTabMinimized}
                  icon={<TerminalGlyph />}
                  title="Terminal 1"
                />
                {browserTabVisible ? (
                  <BrowserTab incoming icon={<GlobeGlyph />} title="localhost:3000" />
                ) : null}
                <span
                  ref={newtabBtnRef}
                  className={cn(
                    'mb-1 inline-flex size-[22px] items-center justify-center rounded-md text-muted-foreground transition-colors duration-150',
                    newtabActive ? 'bg-foreground/10 text-foreground' : null
                  )}
                >
                  <PlusGlyph />
                </span>
              </div>
              {/* New-tab dropdown menu */}
              <div
                aria-hidden={!dropdownVisible}
                className={cn(
                  'absolute z-40 origin-top-left rounded-[10px] p-1 text-[11.5px] transition-[opacity,transform] duration-150',
                  TOUR_FLOATING_SURFACE_CLASS,
                  dropdownVisible
                    ? 'translate-y-0 scale-100 opacity-100'
                    : '-translate-y-[3px] scale-[0.985] opacity-0'
                )}
                style={{
                  top: 'calc(100% + 4px)',
                  left: menuOffsetX,
                  minWidth: 196
                }}
              >
                <DropdownSkeletonRow widthPct={64} />
                <div
                  ref={newtabRowRef}
                  className={cn(
                    'grid items-center gap-2 rounded-md px-2 py-[5px]',
                    newtabRowActive ? 'bg-black/8 dark:bg-white/14' : null
                  )}
                  style={{ gridTemplateColumns: '18px 1fr' }}
                >
                  <span className="inline-flex size-[13px] items-center justify-center text-popover-foreground">
                    <GlobeGlyph />
                  </span>
                  <span className="text-[11.5px] text-popover-foreground">New Browser Tab</span>
                  <span className="font-mono text-[10.5px] text-muted-foreground">
                    {newBrowserShortcutLabel}
                  </span>
                </div>
                <DropdownSkeletonRow widthPct={52} />
              </div>
            </div>

            {/* URL toolbar — hidden until tab reveals so the panel reads as
                "tab created → page came alive" instead of a static frame. */}
            <div
              className="flex items-center gap-2 border-b border-border bg-muted/20 px-2.5 py-1.5"
              style={{ visibility: browserChromeVisible ? 'visible' : 'hidden' }}
            >
              <span className="inline-flex gap-1 text-muted-foreground">
                <NavGlyph>‹</NavGlyph>
                <NavGlyph>›</NavGlyph>
                <NavGlyph>↻</NavGlyph>
              </span>
              <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden rounded-md border border-border bg-card px-2 py-[3px] font-mono text-[11px]">
                {isSplit ? (
                  <span className="truncate text-muted-foreground transition-colors duration-200">
                    {`...${showSignup ? '/signup' : '/pricing'}`}
                  </span>
                ) : (
                  <>
                    <span className="truncate text-foreground">localhost:3000</span>
                    <span className="truncate text-muted-foreground transition-colors duration-200">
                      {showSignup ? '/signup' : '/pricing'}
                    </span>
                  </>
                )}
              </div>
            </div>

            {/* Browser body — relative + overflow-{hidden|visible} so the
                cursor can escape during the new-tab intro to reach the
                titlebar's "+" / dropdown rows. */}
            <div
              className="relative flex-1 bg-card"
              style={{
                overflow: bodyOverflowVisible ? 'visible' : 'hidden',
                minHeight: 0
              }}
            >
              <div
                ref={browserPageRef}
                className="relative flex flex-col gap-3 px-5 py-4"
                style={{ visibility: browserChromeVisible ? 'visible' : 'hidden' }}
              >
                {showSignup ? (
                  <SignupView />
                ) : (
                  <PricingView
                    cardRef={starterCardRef}
                    ctaRef={ctaRef}
                    ringStarter={ringStarter}
                    ctaHighlighted={ctaHighlighted}
                    ctaPressing={ctaPressing}
                  />
                )}

                <div
                  aria-hidden={!annotateOpen}
                  className={cn(
                    'pointer-events-none absolute z-30 flex origin-top-left flex-col gap-1.5 rounded-md px-[9px] pb-[7px] pt-2 text-[10px] transition-[opacity,transform] duration-200',
                    TOUR_FLOATING_SURFACE_CLASS,
                    annotateOpen ? 'scale-100 opacity-100' : 'scale-[0.96] opacity-0'
                  )}
                  style={{ left: annotateAnchor.left, top: annotateAnchor.top, width: 188 }}
                >
                  <span className="block w-full shrink-0 truncate font-mono text-[9.5px] leading-none text-muted-foreground">
                    div.pricing-grid &gt; div.card.starter:nth-of-type(1) &gt; a.cta
                  </span>
                  <span aria-hidden className="h-px w-full shrink-0 bg-popover-foreground/10" />
                  <div className="min-h-[28px] flex-1 break-words font-sans text-[10px] leading-[1.35] text-popover-foreground">
                    {typedChars > 0 ? (
                      <>
                        {PROMPT_TEXT.slice(0, typedChars)}
                        <span className="ml-px inline-block h-2 w-px translate-y-[1px] bg-popover-foreground align-baseline" />
                      </>
                    ) : (
                      <span className="text-muted-foreground">Describe the change…</span>
                    )}
                  </div>
                  <div className="flex justify-end">
                    <span
                      ref={sendBtnRef}
                      aria-label="Send to Claude"
                      className={cn(
                        'inline-flex size-5 shrink-0 items-center justify-center rounded border border-border bg-muted text-foreground transition-[background-color,transform] duration-150',
                        sendPressed ? 'scale-[0.92] bg-foreground/[0.12]' : null
                      )}
                    >
                      <ClaudeIcon size={12} />
                    </span>
                  </div>
                </div>

                <span
                  key={flashKey}
                  aria-hidden
                  className={cn(
                    'pointer-events-none absolute inset-0 z-40 bg-background/85 dark:bg-foreground/12',
                    flashing ? 'animate-[browserFlash_360ms_ease-out_forwards]' : 'opacity-0'
                  )}
                />
              </div>
              <div
                aria-hidden
                className={cn(
                  'pointer-events-none absolute left-0 top-0 z-50 transition-[opacity,transform] duration-700 ease-[cubic-bezier(.45,.05,.2,1)]',
                  cursorVisible ? 'opacity-100' : 'opacity-0'
                )}
                style={{ transform: `translate(${cursorPos.x}px, ${cursorPos.y}px)` }}
              >
                <div className="relative">
                  <CursorIcon />
                  {clickRingVisible ? <FeatureWallClickRing key={clickRingKey} /> : null}
                </div>
              </div>
            </div>
          </div>

          <div
            className={cn(
              'flex min-w-0 flex-col overflow-hidden rounded-xl border border-border bg-card font-mono text-[10px] text-card-foreground shadow-xs transition-[opacity,transform] duration-500',
              isSplit ? 'translate-x-0 opacity-100' : 'translate-x-2 opacity-0'
            )}
          >
            <div className="flex h-5 shrink-0 items-center gap-1.5 border-b border-border bg-muted/40 px-2 text-[9.5px] font-medium text-foreground">
              <ClaudeIcon size={11} />
              <span>Claude</span>
            </div>
            <div className="flex flex-1 flex-col gap-1 px-2 py-2 leading-snug">
              {TERM_ENTRIES.map(({ entry, minPhase }, i) => (
                <TerminalLine key={i} visible={phaseAtLeast(phase, minPhase)}>
                  <TermEntryView entry={entry} />
                </TerminalLine>
              ))}
            </div>
          </div>
        </div>
      </div>
      <style>{`
        @keyframes browserFlash {
          0%   { opacity: 0; }
          20%  { opacity: 0.85; }
          100% { opacity: 0; }
        }
        @keyframes browserTabIn {
          from { opacity: 0; transform: translateY(-2px); }
          to   { opacity: 1; transform: none; }
        }
        @keyframes browserViewIn {
          from { opacity: 0; transform: translateY(4px); }
          to   { opacity: 1; transform: none; }
        }
      `}</style>
    </div>
  )
}

function BrowserTab(props: {
  icon: ReactNode
  title: string
  minimized?: boolean
  incoming?: boolean
}): JSX.Element {
  const { icon, title, minimized, incoming } = props
  return (
    <span
      className={cn(
        'relative inline-flex shrink-0 items-center gap-1.5 rounded-t-md border border-b-0 border-border bg-card px-2.5 pb-1.5 pt-1 text-[11px] text-foreground',
        minimized ? 'gap-0 px-2' : null,
        incoming ? 'animate-[browserTabIn_320ms_cubic-bezier(.2,.8,.2,1)_both]' : null
      )}
      style={{ top: 1 }}
    >
      <span className="inline-flex size-3 items-center justify-center text-muted-foreground">
        {icon}
      </span>
      {minimized ? null : (
        <span className="whitespace-nowrap text-[11px] text-foreground">{title}</span>
      )}
    </span>
  )
}

function DropdownSkeletonRow(props: { widthPct: number }): JSX.Element {
  return (
    <div
      className="grid items-center gap-2 rounded-md px-2 py-[5px]"
      style={{ gridTemplateColumns: '18px 1fr' }}
    >
      <span className="size-[13px] rounded-[3px] bg-popover-foreground/10" />
      <span
        className="h-[7px] rounded-[3px] bg-popover-foreground/10"
        style={{ width: `${props.widthPct}%` }}
      />
    </div>
  )
}

function TermEntryView(props: { entry: TermEntry }): JSX.Element {
  const { entry } = props
  if (entry.kind === 'prompt') {
    return (
      <span className="text-card-foreground">
        <span className="text-muted-foreground">&gt;</span> {entry.text}
      </span>
    )
  }
  if (entry.kind === 'working') {
    return (
      <span className="inline-flex items-center gap-1.5 text-muted-foreground">
        <span className="size-1.5 animate-pulse rounded-full bg-emerald-500 dark:bg-emerald-400" />
        Working…
      </span>
    )
  }
  if (entry.kind === 'ok') {
    return <span className="text-emerald-600 dark:text-emerald-400">{entry.html}</span>
  }
  if (entry.kind === 'tool') {
    return (
      <span>
        <span className="text-violet-600 dark:text-violet-400">{entry.tool}</span>{' '}
        <span className="text-emerald-600 dark:text-emerald-400">{entry.arg}</span>
      </span>
    )
  }
  return (
    <span>
      <span className="text-violet-600 dark:text-violet-400">{entry.tool}</span>{' '}
      <span className="text-muted-foreground">{entry.muted}</span>
    </span>
  )
}

function TerminalLine(props: { visible: boolean; children: ReactNode }): JSX.Element {
  return (
    <span
      className={cn('transition-opacity duration-300', props.visible ? 'opacity-100' : 'opacity-0')}
    >
      {props.children}
    </span>
  )
}

function PricingView(props: {
  cardRef: React.RefObject<HTMLDivElement | null>
  ctaRef: React.RefObject<HTMLSpanElement | null>
  ringStarter: boolean
  ctaHighlighted: boolean
  ctaPressing: boolean
}): JSX.Element {
  return (
    <>
      <div className="text-[15px] font-bold leading-tight">Pricing</div>
      <div className="h-2 w-4/5 rounded bg-foreground/10" />
      <div className="mt-1 grid grid-cols-2 gap-2.5">
        <PricingCard
          cardRef={props.cardRef}
          ctaRef={props.ctaRef}
          label="Starter"
          cta="Try free"
          target
          ringActive={props.ringStarter}
          ctaHighlighted={props.ctaHighlighted}
          ctaPressing={props.ctaPressing}
        />
        <PricingCard label="Pro" cta="Get Pro" highlighted />
      </div>
    </>
  )
}

function SignupView(): JSX.Element {
  return (
    <div className="flex animate-[browserViewIn_360ms_cubic-bezier(.2,.8,.2,1)_both] flex-col gap-3">
      <div className="text-[15px] font-bold leading-tight">Start your free trial</div>
      <div className="h-2 w-[70%] rounded bg-foreground/10" />
      <div className="-mt-1 h-2 w-[55%] rounded bg-foreground/10" />
    </div>
  )
}

function PricingCard(props: {
  label: string
  cta: string
  highlighted?: boolean
  target?: boolean
  ringActive?: boolean
  ctaHighlighted?: boolean
  ctaPressing?: boolean
  cardRef?: React.RefObject<HTMLDivElement | null>
  ctaRef?: React.RefObject<HTMLSpanElement | null>
}): JSX.Element {
  const {
    label,
    cta,
    highlighted,
    target,
    ringActive,
    ctaHighlighted,
    ctaPressing,
    cardRef,
    ctaRef
  } = props
  const ctaIsBranded = ctaHighlighted && !highlighted
  return (
    <div
      ref={cardRef}
      className="relative flex flex-col gap-1.5 rounded-md border border-border bg-card p-2.5"
    >
      {target ? (
        <span
          aria-hidden
          className={cn(
            'pointer-events-none absolute -inset-[3px] rounded-[10px] border-2 border-blue-500 bg-blue-500/10 transition-opacity duration-300',
            ringActive ? 'opacity-100' : 'opacity-0'
          )}
        />
      ) : null}
      <span className="text-[11.5px] font-semibold">{label}</span>
      <div className="h-1.5 w-3/5 rounded bg-foreground/10" />
      <div className="h-1.5 w-4/5 rounded bg-foreground/10" />
      <span
        ref={ctaRef}
        className={cn(
          'mt-1 inline-flex w-fit items-center rounded-md px-2 py-1 text-[11px] font-semibold transition-[background-color,color,box-shadow,transform] duration-300',
          highlighted
            ? 'bg-foreground text-background'
            : ctaIsBranded
              ? 'bg-blue-600 text-white shadow-[0_6px_16px_rgba(37,99,235,0.35)]'
              : 'bg-foreground/[0.07] text-foreground',
          ctaPressing ? 'scale-[0.96]' : null
        )}
      >
        {cta}
      </span>
    </div>
  )
}

function NavGlyph(props: { children: ReactNode }): JSX.Element {
  return (
    <span className="inline-flex size-[18px] items-center justify-center rounded text-muted-foreground">
      {props.children}
    </span>
  )
}

function PlusGlyph(): JSX.Element {
  return (
    <svg
      width={12}
      height={12}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      aria-hidden
    >
      <path d="M8 3v10M3 8h10" />
    </svg>
  )
}

function TerminalGlyph(): JSX.Element {
  return (
    <svg
      width={12}
      height={12}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="m4 6 2.5 2L4 10" />
      <path d="M8.5 11h3.5" />
    </svg>
  )
}

function GlobeGlyph(): JSX.Element {
  return (
    <svg
      width={12}
      height={12}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      aria-hidden
    >
      <circle cx={8} cy={8} r={5.5} />
      <path d="M2.5 8h11M8 2.5c2 1.7 2 9.3 0 11M8 2.5c-2 1.7-2 9.3 0 11" />
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
