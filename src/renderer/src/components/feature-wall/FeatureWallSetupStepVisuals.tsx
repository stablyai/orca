/* eslint-disable max-lines -- Why: these setup visuals are self-contained storyboards; splitting the phase markup from timing and measured cursor logic would make the animation harder to verify. */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { JSX, MutableRefObject, ReactNode, RefObject } from 'react'
import { FolderGit2, Plus } from 'lucide-react'
import { cn } from '@/lib/utils'
import { ClaudeIcon } from '../status-bar/icons'
import { useShortcutLabel } from '@/hooks/useShortcutLabel'
import { CodexInlineIcon, CursorIcon, WorkingSpinner } from './feature-tour-preview-glyphs'
import { WorkbenchAnimatedVisual } from './WorkbenchAnimatedVisual'
import { FeatureWallClickRing } from './FeatureWallClickRing'

type WorktreePhase =
  | 'claude-active'
  | 'plus-hover'
  | 'plus-click'
  | 'modal'
  | 'modal-name-start'
  | 'modal-name-complete'
  | 'modal-hover'
  | 'create-click'
  | 'modal-closing'
  | 'codex-starting'
  | 'codex-typing-start'
  | 'codex-typing-mid'
  | 'codex-submitted'
  | 'both-working'

const WORKTREE_PHASES: readonly WorktreePhase[] = [
  'claude-active',
  'claude-active',
  'plus-hover',
  'plus-hover',
  'plus-click',
  'modal',
  'modal-name-start',
  'modal-name-complete',
  // Why: allow the cursor to slide onto and highlight the "Create" button before click.
  'modal-hover',
  'modal-hover',
  'create-click',
  // Why: the new worktree should not appear until the create dialog has cleared.
  'modal-closing',
  'codex-starting',
  'codex-typing-start',
  'codex-typing-mid',
  'codex-submitted',
  'both-working',
  'both-working',
  'both-working'
]

const CODEX_WORKTREE_NAME = 'checkout fix'
const CODEX_WORKTREE_PROMPT = 'fix checkout timeout'
const WORKTREE_NAME_TYPE_PER_CHAR_MS = 70
const WORKTREE_PROMPT_TYPE_PER_CHAR_MS = 55

export function SetupTwoAgentsVisual(props: { reducedMotion: boolean }): JSX.Element {
  return (
    <WorkbenchAnimatedVisual reducedMotion={props.reducedMotion} variant="two-agents-checklist" />
  )
}

export function SetupWorkspacesVisual(props: { reducedMotion: boolean }): JSX.Element {
  const { reducedMotion } = props
  const rootRef = useRef<HTMLDivElement | null>(null)
  const plusRef = useRef<HTMLSpanElement | null>(null)
  const createButtonRef = useRef<HTMLDivElement | null>(null)
  const modalNameTimeoutsRef = useRef<number[]>([])
  const codexPromptTimeoutsRef = useRef<number[]>([])
  const newWorktreeShortcut = useShortcutLabel('workspace.create')
  const phase = useLoopedPhase(WORKTREE_PHASES, 900, reducedMotion, 'both-working')
  const [modalNameValue, setModalNameValue] = useState(() =>
    reducedMotion ? CODEX_WORKTREE_NAME : ''
  )
  const [codexPromptText, setCodexPromptText] = useState(() =>
    reducedMotion ? CODEX_WORKTREE_PROMPT : ''
  )
  const plusHovered = phase === 'plus-hover'
  const plusClicked = phase === 'plus-click'
  const modalVisible =
    phase === 'modal' ||
    phase === 'modal-name-start' ||
    phase === 'modal-name-complete' ||
    phase === 'modal-hover' ||
    phase === 'create-click'
  const createHovered = phase === 'modal-hover' || phase === 'create-click'
  const createClicked = phase === 'create-click'
  const codexStarting = phase === 'codex-starting'
  const codexTyping = phase === 'codex-typing-start' || phase === 'codex-typing-mid'
  const codexSubmitted = phase === 'codex-submitted'
  const codexWorking = phase === 'both-working'
  const codexWorktreeVisible = codexStarting || codexTyping || codexSubmitted || codexWorking
  const modalNameTyping = phase === 'modal-name-start'
  const cursorTarget =
    phase === 'claude-active'
      ? 'start'
      : phase === 'plus-hover' ||
          phase === 'plus-click' ||
          phase === 'modal' ||
          phase === 'modal-name-start' ||
          phase === 'modal-name-complete'
        ? 'plus'
        : phase === 'modal-hover' || phase === 'create-click'
          ? 'create'
          : 'hidden'
  const cursor = useMeasuredCursor(rootRef, plusRef, createButtonRef, cursorTarget, reducedMotion)

  useEffect(() => {
    return () => {
      clearTypedTimeouts(modalNameTimeoutsRef)
      clearTypedTimeouts(codexPromptTimeoutsRef)
    }
  }, [])

  useEffect(() => {
    if (reducedMotion) {
      clearTypedTimeouts(modalNameTimeoutsRef)
      setModalNameValue(CODEX_WORKTREE_NAME)
      return
    }

    if (phase === 'modal') {
      clearTypedTimeouts(modalNameTimeoutsRef)
      setModalNameValue('')
      return
    }

    if (phase === 'modal-name-start') {
      scheduleTypedText(
        modalNameTimeoutsRef,
        CODEX_WORKTREE_NAME,
        WORKTREE_NAME_TYPE_PER_CHAR_MS,
        setModalNameValue
      )
      return
    }

    if (modalVisible || codexWorktreeVisible) {
      clearTypedTimeouts(modalNameTimeoutsRef)
      setModalNameValue(CODEX_WORKTREE_NAME)
      return
    }

    clearTypedTimeouts(modalNameTimeoutsRef)
    setModalNameValue('')
  }, [codexWorktreeVisible, modalVisible, phase, reducedMotion])

  useEffect(() => {
    if (reducedMotion) {
      clearTypedTimeouts(codexPromptTimeoutsRef)
      setCodexPromptText(CODEX_WORKTREE_PROMPT)
      return
    }

    if (phase === 'codex-typing-start') {
      scheduleTypedText(
        codexPromptTimeoutsRef,
        CODEX_WORKTREE_PROMPT,
        WORKTREE_PROMPT_TYPE_PER_CHAR_MS,
        setCodexPromptText
      )
      return
    }

    // Why: the prompt is long enough to keep typing across the second typing beat.
    if (phase === 'codex-typing-mid') {
      return
    }

    if (codexSubmitted || codexWorking) {
      clearTypedTimeouts(codexPromptTimeoutsRef)
      setCodexPromptText(CODEX_WORKTREE_PROMPT)
      return
    }

    clearTypedTimeouts(codexPromptTimeoutsRef)
    setCodexPromptText('')
  }, [codexSubmitted, codexWorking, phase, reducedMotion])

  return (
    <div
      ref={rootRef}
      className="relative grid min-h-[320px] gap-3 overflow-hidden rounded-xl border border-border bg-card p-3 text-foreground shadow-xs md:grid-cols-[220px_minmax(0,1fr)]"
    >
      <div className="flex min-w-0 flex-col gap-1.5 rounded-lg border border-sidebar-border bg-sidebar p-2 text-sidebar-foreground">
        <ProjectSidebarRow
          plusRef={plusRef}
          plusActive={plusHovered || plusClicked}
          plusHovered={plusHovered}
          shortcut={newWorktreeShortcut}
          worktreeCount={codexWorktreeVisible ? 2 : 1}
        />
        <div className="relative flex min-w-0 flex-col gap-1.5">
          <WorkspaceListCard
            title="release notes"
            active
            prompt="draft release notes"
            icon={<ClaudeIcon size={12} />}
            state="working"
            reducedMotion={reducedMotion}
          />
          <WorkspaceListCard
            title="checkout fix"
            active={codexWorktreeVisible}
            prompt="fix checkout timeout"
            icon={<CodexInlineIcon />}
            state={
              codexSubmitted || codexWorking
                ? 'working'
                : codexWorktreeVisible
                  ? 'starting'
                  : 'idle'
            }
            reducedMotion={reducedMotion}
            className={cn(
              'transition-[opacity,transform]',
              codexWorktreeVisible
                ? 'translate-y-0 opacity-100 duration-500'
                : '-translate-y-1 opacity-0 duration-0'
            )}
          />
        </div>
      </div>

      <div className="relative grid min-w-0 gap-3 md:grid-rows-[88px_minmax(0,1fr)]">
        <div className="min-w-0 overflow-hidden rounded-lg border border-border bg-background">
          <VisualTitlebar title="release notes - Claude Code" compact />
          <div className="space-y-1.5 p-2.5 font-mono text-[11px]">
            <TerminalLine>
              <Prompt>&gt;</Prompt> draft release notes
            </TerminalLine>
            <TerminalLine muted>
              <WorkingSpinner size="xs" reducedMotion={reducedMotion} />
              Edit release-notes.md
            </TerminalLine>
          </div>
        </div>

        <div
          className={cn(
            'min-w-0 overflow-hidden rounded-lg border border-border bg-background transition-[opacity,transform]',
            codexWorktreeVisible
              ? 'translate-y-0 opacity-100 duration-500'
              : 'translate-y-2 opacity-0 duration-0'
          )}
        >
          <VisualTitlebar title="checkout fix - Codex" compact />
          <div className="space-y-1.5 p-2.5 font-mono text-[11px]">
            {codexStarting ? (
              <TerminalLine muted>
                <CodexInlineIcon />
                Codex session ready
              </TerminalLine>
            ) : (
              <TerminalLine>
                <Prompt>&gt;</Prompt>
                {codexPromptText}
                {codexTyping ? (
                  <span className="ml-px inline-block h-[10px] w-[5px] -translate-y-px animate-pulse bg-foreground align-[-1px]" />
                ) : null}
              </TerminalLine>
            )}
            <TerminalLine muted>
              <CodexInlineIcon />
              {codexWorking
                ? 'Read checkout.test.ts'
                : codexSubmitted
                  ? 'Reading checkout.test.ts'
                  : 'Waiting'}
            </TerminalLine>
            {codexWorking ? (
              <TerminalLine muted>
                <WorkingSpinner size="xs" reducedMotion={reducedMotion} />
                Edit src/checkout.ts
              </TerminalLine>
            ) : null}
          </div>
        </div>

        <NewWorkspaceModal
          visible={modalVisible}
          createHovered={createHovered}
          createClicked={createClicked}
          createButtonRef={createButtonRef}
          nameValue={modalNameValue}
          nameTyping={modalNameTyping}
        />
      </div>
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
          {plusClicked || createClicked ? <FeatureWallClickRing /> : null}
        </div>
      </div>
    </div>
  )
}

function ProjectSidebarRow(props: {
  plusRef: RefObject<HTMLSpanElement | null>
  plusActive: boolean
  plusHovered: boolean
  shortcut: string
  worktreeCount: number
}): JSX.Element {
  return (
    <div
      aria-hidden
      className="relative flex h-8 min-w-0 items-center gap-1.5 rounded-md px-1.5 text-sidebar-foreground"
    >
      <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground">
        <FolderGit2 className="size-3.5" />
      </span>
      <span className="min-w-0 flex-1 truncate text-[13px] font-semibold leading-none">orca</span>
      <span className="min-w-[3.75rem] rounded-full bg-sidebar-accent px-1.5 py-0.5 text-center text-[9px] font-medium leading-none text-muted-foreground">
        {props.worktreeCount} worktree{props.worktreeCount === 1 ? '' : 's'}
      </span>
      <span
        ref={props.plusRef}
        className={cn(
          'relative flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors',
          props.plusActive ? 'bg-sidebar-accent text-sidebar-accent-foreground' : null
        )}
      >
        <Plus className="size-3.5" />
      </span>
      <div
        className={cn(
          'pointer-events-none absolute left-[calc(100%+0.375rem)] top-0 z-10 flex h-7 w-max items-center gap-2 whitespace-nowrap rounded-md border border-border bg-popover px-2.5 text-[11px] font-medium text-popover-foreground shadow-xs transition-[opacity,transform] duration-200',
          props.plusHovered ? 'translate-y-0 opacity-100' : '-translate-y-1 opacity-0'
        )}
      >
        <span className="whitespace-nowrap">New worktree</span>
        <kbd className="rounded border border-border bg-background px-1.5 py-0.5 font-mono text-[10px] font-medium text-muted-foreground">
          {props.shortcut}
        </kbd>
      </div>
    </div>
  )
}

function NewWorkspaceModal(props: {
  visible: boolean
  createHovered: boolean
  createClicked: boolean
  createButtonRef: RefObject<HTMLDivElement | null>
  nameValue: string
  nameTyping: boolean
}): JSX.Element {
  return (
    <div
      className={cn(
        'pointer-events-none absolute inset-0 flex items-center justify-center rounded-lg bg-background/55 transition-opacity duration-300',
        props.visible ? 'opacity-100' : 'opacity-0'
      )}
      aria-hidden
    >
      <div
        className={cn(
          'relative w-[min(250px,88%)] rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-xs transition-[opacity,transform] duration-300',
          props.visible
            ? 'translate-y-0 scale-100 opacity-100'
            : 'translate-y-2 scale-[0.98] opacity-0'
        )}
      >
        <div className="text-sm font-semibold leading-none text-foreground">Create Worktree</div>
        <div className="mt-3 space-y-2">
          <ModalField label="Project" value="orca" />
          <ModalField label="Name" value={props.nameValue} typing={props.nameTyping} />
          <ModalField label="Agent" value="Codex" icon={<CodexInlineIcon />} />
        </div>
        <div
          ref={props.createButtonRef}
          aria-hidden
          className={cn(
            'relative mt-3 flex h-8 w-full items-center justify-center rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground transition-all duration-200',
            props.createHovered ? 'opacity-90' : null,
            props.createClicked ? 'scale-[0.98]' : null
          )}
        >
          Create worktree
        </div>
      </div>
    </div>
  )
}

function clearTypedTimeouts(ref: MutableRefObject<number[]>): void {
  for (const timeoutId of ref.current) {
    window.clearTimeout(timeoutId)
  }
  ref.current = []
}

function scheduleTypedText(
  ref: MutableRefObject<number[]>,
  text: string,
  perCharMs: number,
  setValue: (value: string) => void
): void {
  clearTypedTimeouts(ref)
  setValue('')
  for (let i = 1; i <= text.length; i += 1) {
    ref.current.push(window.setTimeout(() => setValue(text.slice(0, i)), i * perCharMs))
  }
}

function useMeasuredCursor(
  rootRef: RefObject<HTMLDivElement | null>,
  plusRef: RefObject<HTMLElement | null>,
  createButtonRef: RefObject<HTMLElement | null>,
  target: 'hidden' | 'start' | 'plus' | 'create',
  reducedMotion: boolean
): { x: number; y: number; visible: boolean } {
  const [pos, setPos] = useState({ x: 0, y: 0, visible: false })

  // Why: measuring targets keeps the cursor aligned as the setup card resizes.
  useLayoutEffect(() => {
    if (reducedMotion || target === 'hidden') {
      setPos((current) => ({ ...current, visible: false }))
      return
    }
    const root = rootRef.current
    if (target === 'start') {
      setPos({ x: 34, y: 218, visible: true })
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

function ModalField(props: {
  label: string
  value: string
  icon?: ReactNode
  typing?: boolean
}): JSX.Element {
  return (
    <div>
      <div className="text-[11px] font-medium text-muted-foreground">{props.label}</div>
      <div className="mt-1 flex h-7 items-center gap-1.5 rounded-md border border-border bg-background px-2 text-xs font-medium text-foreground">
        {props.icon ? <span className="flex size-3.5 shrink-0 items-center">{props.icon}</span> : null}
        <span className="truncate">{props.value}</span>
        {props.typing ? (
          <span className="ml-px inline-block h-[10px] w-[5px] animate-pulse bg-foreground" />
        ) : null}
      </div>
    </div>
  )
}

function useLoopedPhase<T extends string>(
  phases: readonly T[],
  intervalMs: number,
  reducedMotion: boolean,
  reducedMotionPhase: T
): T {
  const [idx, setIdx] = useState(() => {
    const reducedIdx = phases.indexOf(reducedMotionPhase)
    return reducedMotion && reducedIdx >= 0 ? reducedIdx : 0
  })

  useEffect(() => {
    if (reducedMotion) {
      const reducedIdx = phases.indexOf(reducedMotionPhase)
      setIdx(Math.max(reducedIdx, 0))
      return
    }
    setIdx(0)
    const id = window.setInterval(() => {
      setIdx((current) => (current + 1) % phases.length)
    }, intervalMs)
    return () => window.clearInterval(id)
  }, [intervalMs, phases, reducedMotion, reducedMotionPhase])

  return phases[idx] ?? phases[0]
}

function VisualTitlebar(props: { title: string; compact?: boolean }): JSX.Element {
  return (
    <div
      className={cn(
        'flex items-center gap-1.5 border-b border-border bg-muted/40',
        props.compact ? 'h-6 px-2' : 'h-8 px-3'
      )}
    >
      <span className="size-2 rounded-full bg-foreground/15" />
      <span className="size-2 rounded-full bg-foreground/15" />
      <span className="size-2 rounded-full bg-foreground/15" />
      <span className="ml-1 truncate font-mono text-[11px] text-muted-foreground">
        {props.title}
      </span>
    </div>
  )
}

function WorkspaceListCard(props: {
  title: string
  active: boolean
  prompt: string
  icon: ReactNode
  state: 'idle' | 'starting' | 'working'
  reducedMotion: boolean
  className?: string
}): JSX.Element {
  return (
    <div
      className={cn(
        'rounded-md border border-sidebar-border px-2.5 py-2 transition-colors',
        props.active ? 'bg-sidebar-accent' : 'bg-sidebar',
        props.className
      )}
    >
      <div className="flex items-center gap-2">
        <span
          className={cn(
            'size-1.5 shrink-0 rounded-full',
            props.active ? 'bg-emerald-500' : 'bg-muted-foreground/35'
          )}
        />
        <span className="truncate text-xs font-medium text-sidebar-foreground">{props.title}</span>
      </div>
      <div className="mt-2 grid grid-cols-[8px_14px_minmax(0,1fr)] items-center gap-1.5">
        {props.state === 'working' || props.state === 'starting' ? (
          <WorkingSpinner size="xs" reducedMotion={props.reducedMotion} />
        ) : (
          <span className="size-1.5 rounded-full bg-muted-foreground/35" />
        )}
        <span className="flex size-3.5 items-center justify-center text-sidebar-foreground/65">
          {props.icon}
        </span>
        <span className="truncate font-mono text-[11px] text-sidebar-foreground/65">
          {props.state === 'idle' ? 'ready' : props.prompt}
        </span>
      </div>
    </div>
  )
}

function TerminalLine(props: { children: ReactNode; muted?: boolean }): JSX.Element {
  return (
    <div
      className={cn(
        'flex min-w-0 items-center gap-1.5 truncate leading-[1.45]',
        props.muted ? 'text-muted-foreground' : 'text-foreground'
      )}
    >
      {props.children}
    </div>
  )
}

function Prompt(props: { children: ReactNode }): JSX.Element {
  return <span className="shrink-0 text-primary">{props.children}</span>
}
