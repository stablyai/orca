/* oxlint-disable react-doctor/no-adjust-state-on-prop-change -- Why: this visual is a timed storyboard; phase and typed-name state intentionally advance from animation effects and the reduced-motion gate. */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { JSX, ReactNode, RefObject } from 'react'
import { FolderGit2, Plus, TerminalSquare } from 'lucide-react'
import { cn } from '@/lib/utils'
import { ClaudeIcon } from '../status-bar/icons'
import { CodexInlineIcon, CursorIcon, WorkingSpinner } from './feature-tour-preview-glyphs'
import { FeatureWallClickRing } from './FeatureWallClickRing'
import { SetupScriptNewWorkspaceModal } from './SetupScriptNewWorkspaceModal'
import { SetupScriptWorkspaceListCard } from './SetupScriptWorkspaceListCard'

const PHASES = [
  { name: 'create-init', duration: 1200 },
  { name: 'plus-hover', duration: 600 },
  { name: 'plus-click', duration: 400 },
  { name: 'modal-visible', duration: 600 },
  { name: 'modal-typing', duration: 1500 },
  { name: 'modal-complete', duration: 600 },
  { name: 'create-click', duration: 400 },
  { name: 'modal-closing', duration: 400 },
  { name: 'worktree-opening', duration: 1000 },
  { name: 'pane-splitting', duration: 1000 },
  { name: 'setup-running', duration: 2500 },
  { name: 'setup-complete', duration: 800 },
  { name: 'agent-running', duration: 3000 },
  { name: 'dwell', duration: 2000 }
] as const

export function SetupScriptAnimatedVisual(props: { reducedMotion: boolean }): JSX.Element {
  const { reducedMotion } = props
  const rootRef = useRef<HTMLDivElement | null>(null)
  const plusRef = useRef<HTMLSpanElement | null>(null)
  const createButtonRef = useRef<HTMLDivElement | null>(null)

  const [phaseIdx, setPhaseIdx] = useState(0)
  const [modalNameValue, setModalNameValue] = useState('')

  // Why: variable-length timeout loop to perfectly sync animation story beats.
  useEffect(() => {
    if (reducedMotion) {
      setPhaseIdx(PHASES.findIndex((p) => p.name === 'agent-running'))
      return
    }

    let timer: number
    const tick = (idx: number) => {
      const currentPhase = PHASES[idx]
      timer = window.setTimeout(() => {
        const nextIdx = (idx + 1) % PHASES.length
        setPhaseIdx(nextIdx)
        tick(nextIdx)
      }, currentPhase.duration)
    }

    tick(0)

    return () => {
      window.clearTimeout(timer)
    }
  }, [reducedMotion])

  const phase = PHASES[phaseIdx]?.name ?? 'agent-running'

  // Why: type out the worktree name character-by-character to simulate user input.
  useEffect(() => {
    if (reducedMotion) {
      setModalNameValue('checkout fix')
      return
    }

    if (
      phase === 'create-init' ||
      phase === 'plus-hover' ||
      phase === 'plus-click' ||
      phase === 'modal-visible'
    ) {
      setModalNameValue('')
      return
    }

    if (phase === 'modal-typing') {
      const text = 'checkout fix'
      let current = ''
      let idx = 0
      const timer = window.setInterval(() => {
        if (idx < text.length) {
          current += text[idx]
          setModalNameValue(current)
          idx++
        } else {
          window.clearInterval(timer)
        }
      }, 75)
      return () => window.clearInterval(timer)
    }

    setModalNameValue('checkout fix')
    return undefined
  }, [phase, reducedMotion])

  const isWorkspaceActive = !(
    phase === 'create-init' ||
    phase === 'plus-hover' ||
    phase === 'plus-click' ||
    phase === 'modal-visible' ||
    phase === 'modal-typing' ||
    phase === 'modal-complete' ||
    phase === 'create-click' ||
    phase === 'modal-closing'
  )

  const modalVisible =
    phase === 'modal-visible' ||
    phase === 'modal-typing' ||
    phase === 'modal-complete' ||
    phase === 'create-click'

  const plusHovered = phase === 'plus-hover'
  const plusClicked = phase === 'plus-click'
  const createHovered = phase === 'modal-complete'
  const createClicked = phase === 'create-click'

  const cursorTarget =
    phase === 'plus-hover' || phase === 'plus-click'
      ? 'plus'
      : phase === 'modal-complete' || phase === 'create-click'
        ? 'create'
        : phase === 'create-init'
          ? 'start'
          : 'hidden'

  const cursor = useMeasuredCursor(rootRef, plusRef, createButtonRef, cursorTarget, reducedMotion)

  return (
    <div
      ref={rootRef}
      className="relative grid min-h-[240px] gap-3 rounded-xl border border-border bg-card p-3 text-foreground shadow-xs md:grid-cols-[180px_minmax(0,1fr)] overflow-hidden"
    >
      {/* Sidebar */}
      <div className="flex min-w-0 flex-col rounded-lg border border-sidebar-border bg-sidebar p-2 text-sidebar-foreground h-full">
        <div className="flex h-8 items-center justify-between gap-2 px-1.5">
          <div className="flex items-center gap-2 min-w-0">
            <FolderGit2 className="size-3.5 text-muted-foreground" />
            <span className="truncate text-[13px] font-semibold">orca</span>
          </div>
          <span
            ref={plusRef}
            className={cn(
              'relative flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-all duration-300 z-10',
              plusHovered ? 'bg-sidebar-accent text-sidebar-accent-foreground' : null,
              plusClicked
                ? 'scale-90 bg-sidebar-accent text-sidebar-accent-foreground animate-pulse'
                : null
            )}
          >
            <Plus className="size-3.5" />
            {plusClicked && <FeatureWallClickRing />}
          </span>
        </div>

        <div className="mt-1 flex flex-col gap-1.5 min-w-0 flex-1">
          <SetupScriptWorkspaceListCard
            title="release notes"
            active={!isWorkspaceActive}
            prompt="draft release notes"
            icon={<ClaudeIcon size={12} />}
            state={!isWorkspaceActive ? 'working' : 'idle'}
            reducedMotion={reducedMotion}
          />

          <SetupScriptWorkspaceListCard
            title="checkout fix"
            active={isWorkspaceActive}
            prompt="fix checkout timeout"
            icon={<CodexInlineIcon />}
            state={
              phase === 'worktree-opening' || phase === 'pane-splitting'
                ? 'starting'
                : phase === 'setup-running'
                  ? 'setup'
                  : isWorkspaceActive
                    ? 'working'
                    : 'idle'
            }
            reducedMotion={reducedMotion}
            className={cn(
              'transition-all duration-500 ease-in-out',
              isWorkspaceActive
                ? 'opacity-100 translate-y-0 scale-100'
                : 'opacity-0 -translate-y-1 scale-95 h-0 overflow-hidden border-none p-0 m-0'
            )}
          />
        </div>
      </div>

      {/* Terminal Pane / Screen */}
      <div className="relative min-w-0 overflow-hidden rounded-lg border border-border bg-background h-full flex-1">
        {/* Inactive Terminal (Visible when no active worktree) */}
        <div
          className={cn(
            'absolute inset-0 flex flex-col bg-background transition-opacity duration-300 z-10',
            isWorkspaceActive ? 'opacity-0 pointer-events-none' : 'opacity-100'
          )}
        >
          <div className="flex h-7 items-center gap-1.5 border-b border-border bg-muted/40 px-2.5">
            <TerminalSquare className="size-3.5 text-muted-foreground/60" />
            <span className="truncate text-[11px] font-medium text-muted-foreground/60">
              Terminal
            </span>
          </div>
          <div className="flex-1 p-3 font-mono text-[11px] text-muted-foreground/30">
            <div className="flex items-center gap-1.5">
              <span>$</span>
              <span className="h-[10px] w-[5px] bg-muted-foreground/30 animate-pulse" />
            </div>
          </div>
        </div>

        {/* Active Split Terminal Pane (Visible when worktree opens) */}
        <div
          className={cn(
            'absolute inset-0 flex h-full w-full gap-2 p-2 bg-background transition-opacity duration-300 z-20',
            isWorkspaceActive ? 'opacity-100' : 'opacity-0 pointer-events-none'
          )}
        >
          {/* Agent Pane (Left) */}
          <div
            className={cn(
              'flex flex-col rounded-md border border-border bg-card/40 overflow-hidden h-full transition-all duration-700 ease-in-out min-w-0',
              phase === 'worktree-opening' ? 'w-full' : 'w-1/2'
            )}
          >
            <div className="flex h-6 items-center gap-1.5 border-b border-border bg-muted/40 px-2 shrink-0">
              <CodexInlineIcon />
              <span className="truncate text-[10px] font-semibold text-muted-foreground">
                Agent: Codex
              </span>
            </div>
            <div className="flex-1 p-2 font-mono text-[10px] space-y-1.5 overflow-hidden">
              <TerminalLine>
                <Prompt>$</Prompt> orca agent start
              </TerminalLine>
              {phase === 'worktree-opening' ||
              phase === 'pane-splitting' ||
              phase === 'setup-running' ? (
                <TerminalLine muted>
                  <WorkingSpinner size="xs" reducedMotion={reducedMotion} />
                  Waiting for setup script...
                </TerminalLine>
              ) : phase === 'setup-complete' ? (
                <TerminalLine muted>
                  <span>Initializing agent...</span>
                </TerminalLine>
              ) : (
                <>
                  <TerminalLine muted>
                    <span className="text-emerald-500 font-semibold">✓ Setup complete</span>
                  </TerminalLine>
                  <TerminalLine className="text-foreground">
                    <WorkingSpinner size="xs" reducedMotion={reducedMotion} />
                    <span>Running: checkout timeout</span>
                  </TerminalLine>
                  <TerminalLine muted className="pl-3 text-[9px] text-muted-foreground/75">
                    <span>Reading checkout.test.ts</span>
                  </TerminalLine>
                  <TerminalLine muted className="pl-3 text-[9px] text-muted-foreground/75">
                    <span>Modifying checkout.ts</span>
                  </TerminalLine>
                </>
              )}
            </div>
          </div>

          {/* Setup Script Pane (Right - Splits and slides/fades in) */}
          <div
            className={cn(
              'flex flex-col rounded-md border border-border bg-card/40 overflow-hidden h-full transition-all duration-700 ease-in-out min-w-0',
              phase === 'worktree-opening' ? 'w-0 opacity-0 border-none p-0' : 'w-1/2 opacity-100'
            )}
          >
            <div className="flex h-6 items-center gap-1.5 border-b border-border bg-muted/40 px-2 shrink-0">
              <TerminalSquare className="size-3 text-muted-foreground" />
              <span className="truncate text-[10px] font-semibold text-muted-foreground">
                Setup Script
              </span>
            </div>
            <div className="flex-1 p-2 font-mono text-[10px] space-y-1.5 overflow-hidden">
              <TerminalLine>
                <Prompt>$</Prompt> pnpm install
              </TerminalLine>
              {phase === 'pane-splitting' ? (
                <TerminalLine muted>
                  <span className="h-2.5 w-1 bg-muted-foreground/40 animate-pulse" />
                </TerminalLine>
              ) : phase === 'setup-running' ? (
                <>
                  <TerminalLine muted>
                    <WorkingSpinner size="xs" reducedMotion={reducedMotion} />
                    <span>Installing dependencies</span>
                  </TerminalLine>
                  <TerminalLine muted className="text-[9px] text-muted-foreground/75 pl-3">
                    <span>pnpm-lock.yaml found</span>
                  </TerminalLine>
                  <TerminalLine muted className="text-[9px] text-muted-foreground/75 pl-3">
                    <span>Resolving package tree...</span>
                  </TerminalLine>
                </>
              ) : (
                <>
                  <TerminalLine muted className="text-emerald-500">
                    <span className="size-1.5 rounded-full bg-emerald-500 shrink-0" />
                    <span className="font-semibold text-emerald-500">Dependencies ready</span>
                  </TerminalLine>
                  <TerminalLine muted className="text-[9px] text-muted-foreground/75 pl-3">
                    <span>Done in 1.4s</span>
                  </TerminalLine>
                </>
              )}
            </div>
          </div>
        </div>

        {/* Create Worktree Modal Overlay */}
        <SetupScriptNewWorkspaceModal
          visible={modalVisible}
          nameValue={modalNameValue}
          nameTyping={phase === 'modal-typing'}
          createHovered={createHovered}
          createClicked={createClicked}
          createButtonRef={createButtonRef}
        />
      </div>

      {/* Floating Animated Cursor */}
      <div
        aria-hidden
        className={cn(
          'pointer-events-none absolute left-0 top-0 z-50 size-5 drop-shadow-sm transition-[opacity,transform] duration-700 ease-[cubic-bezier(.45,.05,.2,1)] [&_svg]:size-5',
          cursor.visible ? 'opacity-100' : 'opacity-0'
        )}
        style={{ transform: `translate(${cursor.x}px, ${cursor.y}px)` }}
      >
        <div className="relative">
          <CursorIcon />
          {createClicked && <FeatureWallClickRing />}
        </div>
      </div>
    </div>
  )
}

// Why: measuring targets keeps the cursor aligned as the setup card resizes.
function useMeasuredCursor(
  rootRef: RefObject<HTMLDivElement | null>,
  plusRef: RefObject<HTMLElement | null>,
  createButtonRef: RefObject<HTMLDivElement | null>,
  target: 'hidden' | 'start' | 'plus' | 'create',
  reducedMotion: boolean
): { x: number; y: number; visible: boolean } {
  const [pos, setPos] = useState({ x: 0, y: 0, visible: false })

  useLayoutEffect(() => {
    if (reducedMotion || target === 'hidden') {
      setPos((current) => ({ ...current, visible: false }))
      return
    }
    const root = rootRef.current
    if (target === 'start') {
      setPos({ x: 30, y: 150, visible: true })
      return
    }
    const targetNode = target === 'plus' ? plusRef.current : createButtonRef.current
    if (!root || !targetNode) {
      return
    }
    const rootRect = root.getBoundingClientRect()
    const targetRect = targetNode.getBoundingClientRect()
    setPos({
      x: targetRect.left - rootRect.left + targetRect.width * 0.58,
      y: targetRect.top - rootRect.top + targetRect.height * 0.58,
      visible: true
    })
  }, [createButtonRef, plusRef, reducedMotion, rootRef, target])

  return pos
}

function TerminalLine(props: {
  children: ReactNode
  muted?: boolean
  className?: string
}): JSX.Element {
  return (
    <div
      className={cn(
        'flex min-w-0 items-center gap-1.5 truncate leading-[1.45]',
        props.muted ? 'text-muted-foreground' : 'text-foreground',
        props.className
      )}
    >
      {props.children}
    </div>
  )
}

function Prompt(props: { children: ReactNode }): JSX.Element {
  return <span className="shrink-0 text-primary">{props.children}</span>
}
