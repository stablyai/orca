/* oxlint-disable react-doctor/no-adjust-state-on-prop-change -- Why: this visual is a timed storyboard; phase and cursor state intentionally advance from animation effects and reduced-motion gates. */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import { ArrowRight, CircleDot } from 'lucide-react'
import { AgentStateDot } from '@/components/AgentStateDot'
import { ClaudeIcon } from '../status-bar/icons'
import { FeatureWallClickRing } from './FeatureWallClickRing'
import { translate } from '@/i18n/i18n'

type Issue = {
  number: number
  title: string
}

const ISSUES: readonly Issue[] = [
  {
    number: 1842,
    title: translate(
      'auto.components.feature.wall.TasksAnimatedVisual.b13375617e',
      'Worktree picker truncates names'
    )
  }
]

type Phase =
  | { kind: 'idle' }
  | { kind: 'hover'; issueIdx: number }
  | { kind: 'pressing'; issueIdx: number }
  | { kind: 'creating'; issueIdx: number }
  | { kind: 'ready'; issueIdx: number }

// Beat timings (ms). Match the HTML mock's runCycle so the React port reads
// the same as the prototype.
const HOVER_SETTLE_MS = 700
const HOVER_TO_BUTTON_MS = 700
const PRESS_MS = 360
const CREATING_MS = 2000
const READY_MS = 2400
const RESET_MS = 500

function CursorIcon(): JSX.Element {
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 16 16"
      aria-hidden
      focusable="false"
      className="drop-shadow-[0_1px_1px_rgba(0,0,0,0.3)]"
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

type CursorTarget =
  | { kind: 'hidden' }
  | { kind: 'row'; issueIdx: number; settle: boolean }
  | { kind: 'button'; issueIdx: number }

function useFakeCursor(
  panelRef: React.RefObject<HTMLDivElement | null>,
  rowRefs: React.RefObject<(HTMLDivElement | null)[]>,
  buttonRefs: React.RefObject<(HTMLButtonElement | null)[]>,
  target: CursorTarget,
  reducedMotion: boolean
): { x: number; y: number; visible: boolean } {
  const [pos, setPos] = useState<{ x: number; y: number; visible: boolean }>({
    x: 0,
    y: 0,
    visible: false
  })

  // Why: rect math has to run after layout/commit so the row + button refs
  // have measurable boxes. useLayoutEffect avoids a frame of stale position.
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
    if (target.kind === 'row') {
      const row = rowRefs.current?.[target.issueIdx]
      if (!row) {
        return
      }
      const rect = row.getBoundingClientRect()
      const x = rect.left - panelRect.left + (target.settle ? 50 : 30)
      const y = rect.top - panelRect.top + rect.height * 0.7
      setPos({ x: x - 4, y: y - 4, visible: true })
      return
    }
    const btn = buttonRefs.current?.[target.issueIdx]
    if (!btn) {
      return
    }
    const rect = btn.getBoundingClientRect()
    const x = rect.left - panelRect.left + rect.width * 0.5
    const y = rect.top - panelRect.top + rect.height * 0.5
    setPos({ x: x - 4, y: y - 4, visible: true })
  }, [target, reducedMotion, panelRef, rowRefs, buttonRefs])

  return pos
}

export function TasksAnimatedVisual(props: { reducedMotion: boolean }): JSX.Element {
  const { reducedMotion } = props
  const panelRef = useRef<HTMLDivElement | null>(null)
  const rowRefs = useRef<(HTMLDivElement | null)[]>([])
  const buttonRefs = useRef<(HTMLButtonElement | null)[]>([])

  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const [cursorTarget, setCursorTarget] = useState<CursorTarget>({ kind: 'hidden' })
  const [rippleKey, setRippleKey] = useState(0)

  // Why: drive the animation loop as a chain of setTimeouts. Each step is
  // self-contained so reduced-motion can short-circuit the entire effect.
  useEffect(() => {
    if (reducedMotion) {
      setPhase({ kind: 'idle' })
      setCursorTarget({ kind: 'hidden' })
      return
    }
    let cancelled = false
    const timeouts: number[] = []
    function schedule(fn: () => void, delay: number): void {
      const id = window.setTimeout(() => {
        if (cancelled) {
          return
        }
        fn()
      }, delay)
      timeouts.push(id)
    }

    function runCycle(): void {
      const issueIdx = 0
      // 1. Cursor enters and travels toward the row.
      setPhase({ kind: 'idle' })
      setCursorTarget({ kind: 'row', issueIdx, settle: false })
      schedule(() => {
        setCursorTarget({ kind: 'row', issueIdx, settle: true })
      }, 50)

      // 2. Activate the row — Start workspace button slides in.
      schedule(() => {
        setPhase({ kind: 'hover', issueIdx })
      }, 50 + HOVER_SETTLE_MS)
      schedule(
        () => {
          setCursorTarget({ kind: 'button', issueIdx })
        },
        50 + HOVER_SETTLE_MS + 40
      )

      // 3. Click the button.
      const pressStart = 50 + HOVER_SETTLE_MS + 40 + HOVER_TO_BUTTON_MS
      schedule(() => {
        setPhase({ kind: 'pressing', issueIdx })
        setRippleKey((k) => k + 1)
      }, pressStart)

      // 4. Workspace card materializes below with a running agent.
      const creatingStart = pressStart + PRESS_MS
      schedule(() => {
        setPhase({ kind: 'creating', issueIdx })
        setCursorTarget({ kind: 'hidden' })
      }, creatingStart)

      // 5. Agent finishes — flip the spinner to a check.
      const readyStart = creatingStart + CREATING_MS
      schedule(() => {
        setPhase({ kind: 'ready', issueIdx })
      }, readyStart)

      // 6. Tear down for next cycle.
      const teardown = readyStart + READY_MS
      schedule(() => {
        setPhase({ kind: 'idle' })
      }, teardown)
      schedule(() => {
        runCycle()
      }, teardown + RESET_MS)
    }
    runCycle()
    return () => {
      cancelled = true
      timeouts.forEach((id) => window.clearTimeout(id))
    }
  }, [reducedMotion])

  const cursor = useFakeCursor(panelRef, rowRefs, buttonRefs, cursorTarget, reducedMotion)

  const activeIdx =
    phase.kind === 'hover' ||
    phase.kind === 'pressing' ||
    phase.kind === 'creating' ||
    phase.kind === 'ready'
      ? phase.issueIdx
      : -1
  // Why: the dropdown appears as soon as the workspace starts being created so
  // the user sees a "Creating workspace" beat, but the workspace card itself
  // only materialises once the workspace is ready — at which point the Claude
  // agent inside it is already working.
  const showDropdown = phase.kind === 'creating' || phase.kind === 'ready'
  const workspaceCreating = phase.kind === 'creating'
  const workspaceIssue = phase.kind === 'ready' ? ISSUES[phase.issueIdx] : null

  return (
    <div
      ref={panelRef}
      className="relative overflow-hidden rounded-xl border border-border bg-card p-2.5 text-foreground"
    >
      <div>
        {ISSUES.map((issue, i) => {
          const isActive = i === activeIdx
          const isPressing = phase.kind === 'pressing' && phase.issueIdx === i
          return (
            <div
              key={issue.number}
              ref={(node) => {
                rowRefs.current[i] = node
              }}
              className={`grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3.5 rounded-[10px] px-2.5 py-3 transition-[background,box-shadow] duration-300 ${
                i > 0 ? 'mt-1.5' : ''
              } ${
                isActive ? 'bg-foreground/[0.05] shadow-[inset_0_0_0_1px_rgba(24,24,27,0.06)]' : ''
              }`}
            >
              <span className="inline-flex items-center gap-1 rounded-md border border-border/70 bg-muted/50 px-1.5 py-px font-mono text-[11px] text-muted-foreground">
                <CircleDot className="size-[11px]" aria-hidden />
                <span>#{issue.number}</span>
              </span>
              <div className="min-w-0">
                <div className="truncate text-[12.5px] font-semibold leading-[1.2] text-foreground">
                  {issue.title}
                </div>
              </div>
              <div className="relative flex items-center justify-end">
                {!isActive ? (
                  <span className="inline-flex items-center justify-center rounded-full border border-emerald-500/35 bg-emerald-500/10 px-2 py-px text-[10px] font-semibold text-emerald-700 dark:text-emerald-300">
                    {translate(
                      'auto.components.feature.wall.TasksAnimatedVisual.4331c4d0f8',
                      'Open'
                    )}
                  </span>
                ) : (
                  <button
                    type="button"
                    tabIndex={-1}
                    aria-hidden
                    ref={(node) => {
                      buttonRefs.current[i] = node
                    }}
                    className={`pointer-events-none inline-flex items-center gap-1.5 rounded-md bg-foreground px-2.5 py-1 text-[11px] font-semibold text-background transition-[transform,filter] duration-150 ${
                      isPressing ? 'scale-[0.94] brightness-[1.4]' : 'scale-100'
                    }`}
                  >
                    {translate(
                      'auto.components.feature.wall.TasksAnimatedVisual.b68c92fbdc',
                      'Start workspace'
                    )}
                    <ArrowRight className="size-2.5" aria-hidden />
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </div>

      <div
        className={`overflow-hidden transition-all duration-[320ms] ease-out ${
          showDropdown
            ? 'mt-2.5 max-h-[200px] border-t border-border/80 pt-2.5 opacity-100'
            : 'mt-0 max-h-0 border-t border-transparent pt-0 opacity-0'
        }`}
      >
        <div className="flex items-center gap-1.5 px-1 pb-1.5 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
          {workspaceCreating ? (
            <span className="inline-block size-[9px] animate-spin rounded-full border-[1.5px] border-yellow-500 border-t-transparent" />
          ) : (
            <span className="inline-block size-[9px] rounded-full bg-emerald-500" />
          )}
          <span>
            {workspaceCreating
              ? translate(
                  'auto.components.feature.wall.TasksAnimatedVisual.61ffda7601',
                  'Creating workspace'
                )
              : translate(
                  'auto.components.feature.wall.TasksAnimatedVisual.fe47c9c9e8',
                  'Workspace ready'
                )}
          </span>
        </div>
        {workspaceIssue ? (
          <div
            key={workspaceIssue.number}
            className="animate-[tasks-workspace-in_320ms_cubic-bezier(.2,.8,.2,1)_both] rounded-[10px] bg-foreground/[0.05] px-2 py-2.5 shadow-[inset_0_0_0_1px_rgba(24,24,27,0.06)]"
          >
            <div className="grid grid-cols-[14px_minmax(0,1fr)] items-center gap-3 px-1.5">
              <span className="inline-block size-[9px] rounded-full bg-emerald-500" />
              <div className="min-w-0">
                <div className="truncate text-[15px] font-semibold leading-[1.2] text-foreground">
                  {workspaceIssue.title}
                </div>
              </div>
            </div>
            <div className="flex flex-col gap-2.5 pl-[30px] pr-2 pt-2.5 pb-0.5">
              <div className="grid grid-cols-[16px_16px_minmax(0,1fr)] items-center gap-2.5">
                <span className="inline-flex size-4 items-center justify-center">
                  <AgentStateDot state="working" size="md" />
                </span>
                <ClaudeIcon size={14} />
                <span className="truncate font-mono text-[11px] leading-[1.2] text-muted-foreground">
                  {translate(
                    'auto.components.feature.wall.TasksAnimatedVisual.efba6f77eb',
                    'Reading issue #'
                  )}
                  {workspaceIssue.number}…
                </span>
              </div>
            </div>
          </div>
        ) : null}
      </div>

      <div
        aria-hidden
        className={`pointer-events-none absolute left-0 top-0 z-10 transition-[opacity,transform] duration-700 ease-[cubic-bezier(.45,.05,.2,1)] ${
          cursor.visible ? 'opacity-100' : 'opacity-0'
        }`}
        style={{ transform: `translate(${cursor.x}px, ${cursor.y}px)` }}
      >
        <div className="relative">
          <CursorIcon />
          {phase.kind === 'pressing' ? <FeatureWallClickRing key={rippleKey} /> : null}
        </div>
      </div>
    </div>
  )
}
