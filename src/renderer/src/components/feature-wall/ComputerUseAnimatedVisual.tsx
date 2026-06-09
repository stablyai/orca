import { useEffect, useLayoutEffect, useRef, useState, type JSX, type ReactNode } from 'react'
import { GitBranch } from 'lucide-react'
import { cn } from '@/lib/utils'
import { ClaudeIcon } from '../status-bar/icons'
import { FeatureWallClickRing } from './FeatureWallClickRing'
import { CursorIcon } from './feature-tour-preview-glyphs'
import { translate } from '@/i18n/i18n'

type ComputerUsePhase = 'inspect' | 'target' | 'click' | 'verified'

const PHASES: readonly ComputerUsePhase[] = ['inspect', 'target', 'click', 'verified', 'verified']
const PHASE_MS = 1350

// Why: the visual must read as "an agent in an Orca worktree drives the
// local app via the `orca computer` CLI" — each command on the left causes
// the visible effect on the right, in lockstep.
const WORKTREE_LABEL = 'checkout fix'

export function ComputerUseAnimatedVisual(props: {
  reducedMotion: boolean
  onCycleComplete?: () => void
}): JSX.Element {
  const phase = useComputerUsePhase(props.reducedMotion, props.onCycleComplete)
  const containerRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLDivElement>(null)

  const [cursorCoords, setCursorCoords] = useState({ x: 0, y: 0, visible: false })

  const targetVisible = phase === 'target' || phase === 'click' || phase === 'verified'
  const clicked = phase === 'click' || phase === 'verified'
  const verified = phase === 'verified'

  // Why: cursor coordinates are computed against the app body so they survive
  // any reflow when the carousel sizes the slide.
  useLayoutEffect(() => {
    if (props.reducedMotion) {
      setCursorCoords({ x: 0, y: 0, visible: false })
      return
    }

    function updateCoords(): void {
      const container = containerRef.current
      const button = buttonRef.current
      if (!container || !button) {
        return
      }

      const containerRect = container.getBoundingClientRect()
      const buttonRect = button.getBoundingClientRect()

      const buttonX = buttonRect.left - containerRect.left + buttonRect.width * 0.78
      const buttonY = buttonRect.top - containerRect.top + buttonRect.height / 2

      const startX = containerRect.width * 0.35
      const startY = containerRect.height * 0.35

      if (phase === 'inspect' || phase === 'verified') {
        setCursorCoords({ x: startX, y: startY, visible: false })
      } else {
        setCursorCoords({ x: buttonX, y: buttonY, visible: true })
      }
    }

    updateCoords()

    window.addEventListener('resize', updateCoords)
    return () => window.removeEventListener('resize', updateCoords)
  }, [phase, props.reducedMotion])

  return (
    <div className="relative grid min-h-[282px] gap-3 rounded-xl border border-border bg-card p-3 text-foreground shadow-xs md:h-[282px] md:grid-cols-[230px_minmax(0,1fr)]">
      <AgentWorktreeTerminal
        phase={phase}
        targetVisible={targetVisible}
        clicked={clicked}
        verified={verified}
      />

      <div className="relative min-w-0 overflow-hidden rounded-lg border border-border bg-background">
        <div className="flex h-7 items-center gap-1.5 border-b border-border bg-muted/40 px-2.5">
          <span className="size-2 rounded-full bg-rose-400/70" />
          <span className="size-2 rounded-full bg-amber-400/70" />
          <span className="size-2 rounded-full bg-emerald-400/70" />
          <span className="ml-1 truncate text-[11px] font-medium text-muted-foreground">
            {translate("auto.components.feature.wall.ComputerUseAnimatedVisual.9cddfe96b2", "Local app")}</span>
        </div>

        <div className="grid h-[253px] grid-rows-[58px_minmax(0,1fr)] bg-muted/10">
          <div className="border-b border-border bg-card px-4 py-2.5">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0 flex-1 overflow-hidden">
                <div className="h-2.5 w-24 max-w-full rounded-full bg-foreground/20" />
                <div className="mt-2 h-2 w-36 max-w-full rounded-full bg-muted-foreground/25" />
              </div>
              <span
                className={cn(
                  'shrink-0 rounded-full border px-2 py-1 text-[11px] font-medium transition-colors',
                  verified
                    ? 'border-primary/30 bg-primary/10 text-primary'
                    : 'border-border bg-muted/40 text-muted-foreground'
                )}
              >
                {verified ? translate("auto.components.feature.wall.ComputerUseAnimatedVisual.c11dda000b", "Approved") : translate("auto.components.feature.wall.ComputerUseAnimatedVisual.bdd5312213", "Pending")}
              </span>
            </div>
          </div>

          <div ref={containerRef} className="relative p-3">
            <div className="space-y-2">
              <AppRow width="78%" />
              <div
                className={cn(
                  'flex items-center gap-2 rounded-lg border bg-card px-3 py-2.5 transition-[background-color,border-color,box-shadow]',
                  targetVisible
                    ? 'border-ring bg-accent/50 ring-2 ring-ring/30 shadow-xs'
                    : 'border-border'
                )}
              >
                <div className="min-w-0 flex-1 overflow-hidden pr-1">
                  <div className="h-2.5 w-1/2 max-w-16 rounded-full bg-foreground/20" />
                  <div className="mt-2 h-2 w-3/5 max-w-20 rounded-full bg-muted-foreground/25" />
                </div>
                <div
                  ref={buttonRef}
                  aria-hidden
                  className={cn(
                    'flex h-8 w-[72px] shrink-0 items-center justify-center rounded-md border px-2 text-xs font-medium transition-[background-color,color,transform]',
                    clicked
                      ? 'border-primary/30 bg-primary/10 text-primary'
                      : 'border-border bg-secondary text-secondary-foreground',
                    phase === 'click' ? 'scale-[0.97]' : null
                  )}
                >
                  {clicked ? translate("auto.components.feature.wall.ComputerUseAnimatedVisual.3cc2df3671", "Done") : translate("auto.components.feature.wall.ComputerUseAnimatedVisual.9634d870d1", "Approve")}
                </div>
              </div>
            </div>

            <ComputerUseCursor
              visible={cursorCoords.visible}
              x={cursorCoords.x}
              y={cursorCoords.y}
              isClick={phase === 'click'}
            />
          </div>
        </div>
      </div>
    </div>
  )
}

function AgentWorktreeTerminal(props: {
  phase: ComputerUsePhase
  targetVisible: boolean
  clicked: boolean
  verified: boolean
}): JSX.Element {
  return (
    <div className="min-w-0 overflow-hidden rounded-lg border border-border bg-background">
      <div className="flex h-7 items-center gap-1.5 border-b border-border bg-muted/40 px-2.5">
        <ClaudeIcon size={13} />
        <span className="truncate text-[11px] font-medium text-muted-foreground">{translate("auto.components.feature.wall.ComputerUseAnimatedVisual.94787f01f8", "Claude Code")}</span>
        <span className="ml-auto inline-flex min-w-0 items-center gap-1 text-[10px] text-muted-foreground">
          <GitBranch className="size-3" />
          <span className="truncate">{WORKTREE_LABEL}</span>
        </span>
      </div>
      <div className="space-y-1.5 p-3 font-mono text-[10.5px] leading-snug">
        <TerminalLine muted>
          <span className="mr-1.5 text-foreground">●</span>
          {translate("auto.components.feature.wall.ComputerUseAnimatedVisual.2adb561b44", "Claude Code session started")}</TerminalLine>
        <TerminalLine wrap>
          <span className="mr-1.5 text-amber-600">{translate("auto.components.feature.wall.ComputerUseAnimatedVisual.99a8624bcb", ">")}</span>
          {translate("auto.components.feature.wall.ComputerUseAnimatedVisual.79445f7512", "approve the note in my app")}</TerminalLine>
        <ComputerActionLine
          action="Computer"
          target="inspect Notes"
          active={props.phase === 'inspect'}
          done={props.targetVisible}
        />
        <TerminalLine visible={props.targetVisible} indent muted>
          {translate("auto.components.feature.wall.ComputerUseAnimatedVisual.1719b28a81", "found \"Approve\"")}<span>[#7]</span>
        </TerminalLine>
        <ComputerActionLine
          action="Computer"
          target="click Approve"
          active={props.phase === 'target' || props.phase === 'click'}
          done={props.clicked}
        />
        <TerminalLine visible={props.clicked} indent muted>
          {translate("auto.components.feature.wall.ComputerUseAnimatedVisual.6804cb356f", "click sent")}</TerminalLine>
        <ComputerActionLine
          action="Computer"
          target="verify Notes"
          active={props.phase === 'click'}
          done={props.verified}
        />
        <TerminalLine visible={props.verified} indent muted>
          {translate("auto.components.feature.wall.ComputerUseAnimatedVisual.f27676a92c", "status:")}<span className="text-foreground">{translate("auto.components.feature.wall.ComputerUseAnimatedVisual.d8401975b1", "approved")}</span>
        </TerminalLine>
      </div>
    </div>
  )
}

function ComputerActionLine(props: {
  action: string
  target: string
  active: boolean
  done: boolean
}): JSX.Element {
  return (
    <TerminalLine visible={props.active || props.done}>
      {props.done ? <span className="mr-1.5 font-bold text-emerald-600">✓</span> : <RunSpinner />}
      <span className="text-foreground">{props.action}</span>
      <span className="ml-1.5 truncate text-muted-foreground">{props.target}</span>
    </TerminalLine>
  )
}

function TerminalLine(props: {
  children: ReactNode
  muted?: boolean
  wrap?: boolean
  indent?: boolean
  visible?: boolean
}): JSX.Element {
  const visible = props.visible ?? true
  return (
    <div
      className={cn(
        'min-h-[15px] transition-opacity duration-200',
        props.muted ? 'text-muted-foreground' : null,
        props.indent ? 'pl-4' : null,
        props.wrap ? 'whitespace-pre-wrap break-words' : 'truncate whitespace-pre',
        visible ? 'opacity-100' : 'opacity-0'
      )}
    >
      {props.children}
    </div>
  )
}

function RunSpinner(): JSX.Element {
  return (
    <span
      className="mr-1.5 inline-block size-2 animate-spin rounded-full border-[1.5px] border-foreground/20 border-t-foreground align-[-1px]"
      aria-hidden
    />
  )
}

function useComputerUsePhase(
  reducedMotion: boolean,
  onCycleComplete?: () => void
): ComputerUsePhase {
  const [idx, setIdx] = useState(() => (reducedMotion ? PHASES.indexOf('verified') : 0))

  useEffect(() => {
    if (reducedMotion) {
      setIdx(PHASES.indexOf('verified'))
      return
    }
    let cancelled = false
    const timeouts: number[] = []
    const wait = (ms: number): Promise<void> =>
      new Promise((resolve) => {
        const id = window.setTimeout(() => resolve(), ms)
        timeouts.push(id)
      })

    setIdx(0)
    async function loop(): Promise<void> {
      while (!cancelled) {
        for (let nextIdx = 0; nextIdx < PHASES.length; nextIdx += 1) {
          setIdx(nextIdx)
          await wait(PHASE_MS)
          if (cancelled) {
            return
          }
        }
        onCycleComplete?.()
      }
    }
    loop()
    return () => {
      cancelled = true
      timeouts.forEach((id) => window.clearTimeout(id))
    }
  }, [onCycleComplete, reducedMotion])

  return PHASES[idx] ?? 'verified'
}

function AppRow(props: { width: string }): JSX.Element {
  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2">
      <div className="h-2.5 rounded-full bg-foreground/15" style={{ width: props.width }} />
      <div className="mt-2 h-2 w-1/2 rounded-full bg-muted-foreground/20" />
    </div>
  )
}

function ComputerUseCursor(props: {
  visible: boolean
  x: number
  y: number
  isClick: boolean
}): JSX.Element {
  return (
    <div
      aria-hidden
      className={cn(
        'pointer-events-none absolute left-0 top-0 z-20 size-4 transition-[opacity,transform] duration-700 ease-[cubic-bezier(.45,.05,.2,1)]',
        props.visible ? 'opacity-100' : 'opacity-0'
      )}
      style={{
        transform: `translate(${props.x - 4}px, ${props.y - 4}px)`
      }}
    >
      <CursorIcon />
      {props.isClick ? <FeatureWallClickRing /> : null}
    </div>
  )
}
