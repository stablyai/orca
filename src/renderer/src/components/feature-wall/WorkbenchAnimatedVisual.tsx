import { useRef } from 'react'
import type { JSX } from 'react'
import { useShortcutLabel } from '@/hooks/useShortcutLabel'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { FeatureWallClickRing } from './FeatureWallClickRing'
import {
  WorkbenchAgentTerminalPane,
  WorkbenchSourceTerminalContent
} from './WorkbenchTerminalPanes'
import { WorkbenchTerminalSplitMenu } from './WorkbenchTerminalSplitMenu'
import {
  WORKBENCH_RUN_QUEUE,
  getTwoAgentsReducedMotionLines,
  type WorkbenchAnimatedVisualVariant,
  type WorkbenchAnimationPhase,
  type WorkbenchCursorTarget,
  type WorkbenchTerminalLine
} from './workbench-terminal-storyboard-state'
import { useWorkbenchTerminalCursor } from './use-workbench-terminal-cursor'
import { useWorkbenchTerminalStoryboard } from './use-workbench-terminal-storyboard'

const KBD_CLASS =
  'rounded border border-border bg-card px-1.5 py-0.5 font-mono text-[11.5px] text-foreground'

type WorkbenchTerminalVisualState = {
  phase: WorkbenchAnimationPhase
  running: (typeof WORKBENCH_RUN_QUEUE)[number]
  cursorTarget: WorkbenchCursorTarget
  rightTyped: string
  rightLines: readonly WorkbenchTerminalLine[]
  showInputLine: boolean
  promptGlyph: '$' | '>'
  showCaret: boolean
  rippleKey: number
}

export function WorkbenchAnimatedVisual(props: {
  reducedMotion: boolean
  variant?: WorkbenchAnimatedVisualVariant
}): JSX.Element {
  const variant = props.variant ?? 'tour'
  const splitRightShortcutLabel = useShortcutLabel('terminal.splitRight')
  const splitDownShortcutLabel = useShortcutLabel('terminal.splitDown')
  // Why: branch on the state source, not the element type, so a reducedMotion
  // toggle re-renders the storyboard in place instead of remounting it.
  const animatedState = useWorkbenchTerminalStoryboard(variant, props.reducedMotion)

  return (
    <WorkbenchTerminalVisualFrame
      reducedMotion={props.reducedMotion}
      variant={variant}
      splitRightShortcutLabel={splitRightShortcutLabel}
      splitDownShortcutLabel={splitDownShortcutLabel}
      state={props.reducedMotion ? getReducedMotionState(variant) : animatedState}
    />
  )
}

function WorkbenchTerminalVisualFrame(props: {
  reducedMotion: boolean
  variant: WorkbenchAnimatedVisualVariant
  splitRightShortcutLabel: string
  splitDownShortcutLabel: string
  state: WorkbenchTerminalVisualState
}): JSX.Element {
  const panelRef = useRef<HTMLDivElement | null>(null)
  const leftPaneRef = useRef<HTMLDivElement | null>(null)
  const splitRowRef = useRef<HTMLDivElement | null>(null)
  const cursor = useWorkbenchTerminalCursor(
    panelRef,
    leftPaneRef,
    splitRowRef,
    props.state.cursorTarget
  )
  const isTwoAgentsChecklist = props.variant === 'two-agents-checklist'
  const splitOpen =
    props.state.phase.kind === 'menu-click' ||
    props.state.phase.kind === 'split-empty' ||
    props.state.phase.kind === 'split-active'
  const menuShown =
    props.state.phase.kind === 'menu-open' ||
    props.state.phase.kind === 'menu-active' ||
    props.state.phase.kind === 'menu-click'
  const splitRowActive =
    props.state.phase.kind === 'menu-active' || props.state.phase.kind === 'menu-click'
  const showRipple =
    props.state.phase.kind === 'right-click' || props.state.phase.kind === 'menu-click'
  const promptAccentClass = isTwoAgentsChecklist ? 'text-foreground' : 'text-amber-600'

  return (
    <div
      ref={panelRef}
      className="relative overflow-hidden rounded-xl border border-border bg-card text-foreground shadow-[0_1px_2px_rgba(24,24,27,0.04)]"
    >
      <div className="flex h-7 items-center gap-1.5 border-b border-border bg-muted/40 px-3">
        <span className="size-2.5 rounded-full bg-rose-400/70" />
        <span className="size-2.5 rounded-full bg-amber-400/70" />
        <span className="size-2.5 rounded-full bg-emerald-400/70" />
      </div>

      <div
        className={cn(
          'grid bg-[var(--editor-surface)] font-mono text-[11px]',
          props.reducedMotion
            ? 'transition-none'
            : 'transition-[grid-template-columns] duration-[600ms] ease-[cubic-bezier(.2,.8,.2,1)]',
          splitOpen ? 'grid-cols-[1fr_1fr]' : 'grid-cols-[1fr_0fr]'
        )}
        style={{ minHeight: 230 }}
      >
        <div ref={leftPaneRef} className="relative flex min-w-0 flex-col gap-1.5 px-3 py-2.5">
          <WorkbenchSourceTerminalContent
            isTwoAgentsChecklist={isTwoAgentsChecklist}
            running={props.state.running}
            reducedMotion={props.reducedMotion}
          />
          <WorkbenchTerminalSplitMenu
            shown={menuShown}
            splitRowActive={splitRowActive}
            splitRowRef={splitRowRef}
            splitRightShortcutLabel={props.splitRightShortcutLabel}
            splitDownShortcutLabel={props.splitDownShortcutLabel}
          />
        </div>

        <WorkbenchAgentTerminalPane
          splitOpen={splitOpen}
          reducedMotion={props.reducedMotion}
          lines={props.state.rightLines}
          isCodex={isTwoAgentsChecklist}
          promptAccentClass={promptAccentClass}
          showInputLine={props.state.showInputLine}
          promptGlyph={props.state.promptGlyph}
          typedText={props.state.rightTyped}
          showCaret={props.state.showCaret}
        />
      </div>

      <div
        aria-hidden
        className={cn(
          'pointer-events-none absolute left-0 top-0 z-20 transition-[opacity,transform] duration-700 ease-[cubic-bezier(.45,.05,.2,1)]',
          cursor.visible ? 'opacity-100' : 'opacity-0'
        )}
        style={{ transform: `translate(${cursor.x}px, ${cursor.y}px)` }}
      >
        <div className="relative">
          <WorkbenchTerminalPointerIcon />
          {showRipple ? <FeatureWallClickRing key={props.state.rippleKey} /> : null}
        </div>
      </div>

      {isTwoAgentsChecklist ? null : (
        <div className="border-t border-border bg-card px-3 py-2 text-[11px] text-muted-foreground">
          {translate(
            'auto.components.feature.wall.WorkbenchAnimatedVisual.0bc9ad0cd1',
            'Same pane:'
          )}
          <kbd className={KBD_CLASS}>{props.splitRightShortcutLabel}</kbd>{' '}
          {translate(
            'auto.components.feature.wall.WorkbenchAnimatedVisual.a2b114dad0',
            'splits right ·'
          )}{' '}
          <kbd className={KBD_CLASS}>{props.splitDownShortcutLabel}</kbd>{' '}
          {translate(
            'auto.components.feature.wall.WorkbenchAnimatedVisual.16877e038d',
            'splits down'
          )}
        </div>
      )}
    </div>
  )
}

function WorkbenchTerminalPointerIcon(): JSX.Element {
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

function buildReducedMotionState(
  variant: WorkbenchAnimatedVisualVariant
): WorkbenchTerminalVisualState {
  const isTwoAgentsChecklist = variant === 'two-agents-checklist'
  return {
    phase: isTwoAgentsChecklist ? { kind: 'split-active' } : { kind: 'idle' },
    running: WORKBENCH_RUN_QUEUE[0],
    cursorTarget: { kind: 'hidden' },
    rightTyped: '',
    rightLines: isTwoAgentsChecklist ? getTwoAgentsReducedMotionLines() : [],
    showInputLine: !isTwoAgentsChecklist,
    promptGlyph: '$',
    showCaret: !isTwoAgentsChecklist,
    rippleKey: 0
  }
}

// Why: stable identities — a fresh cursorTarget per render would re-fire the cursor layout effect.
const WORKBENCH_TOUR_REDUCED_MOTION_STATE = buildReducedMotionState('tour')
const WORKBENCH_TWO_AGENTS_REDUCED_MOTION_STATE = buildReducedMotionState('two-agents-checklist')

function getReducedMotionState(
  variant: WorkbenchAnimatedVisualVariant
): WorkbenchTerminalVisualState {
  return variant === 'two-agents-checklist'
    ? WORKBENCH_TWO_AGENTS_REDUCED_MOTION_STATE
    : WORKBENCH_TOUR_REDUCED_MOTION_STATE
}
