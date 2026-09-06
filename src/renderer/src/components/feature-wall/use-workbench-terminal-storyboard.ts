import { useEffect, useState } from 'react'
import { installWindowVisibilityInterval } from '@/lib/window-visibility-interval'
import {
  WORKBENCH_RUN_QUEUE,
  WORKBENCH_RUN_TICK_MS,
  type WorkbenchAnimatedVisualVariant,
  type WorkbenchAnimationPhase,
  type WorkbenchCursorTarget,
  type WorkbenchTerminalLine
} from './workbench-terminal-storyboard-state'
import { runWorkbenchTerminalStoryboardSequence } from './workbench-terminal-storyboard-sequence'

export function useWorkbenchTerminalStoryboard(
  variant: WorkbenchAnimatedVisualVariant,
  reducedMotion: boolean
): {
  phase: WorkbenchAnimationPhase
  running: (typeof WORKBENCH_RUN_QUEUE)[number]
  cursorTarget: WorkbenchCursorTarget
  rightTyped: string
  rightLines: readonly WorkbenchTerminalLine[]
  showInputLine: boolean
  promptGlyph: '$' | '>'
  showCaret: boolean
  rippleKey: number
} {
  const isTwoAgentsChecklist = variant === 'two-agents-checklist'
  const [phase, setPhase] = useState<WorkbenchAnimationPhase>({ kind: 'idle' })
  const [runIdx, setRunIdx] = useState(0)
  const [cursorTarget, setCursorTarget] = useState<WorkbenchCursorTarget>({ kind: 'hidden' })
  const [rightTyped, setRightTyped] = useState('')
  const [rightLines, setRightLines] = useState<readonly WorkbenchTerminalLine[]>([])
  const [showInputLine, setShowInputLine] = useState(true)
  const [promptGlyph, setPromptGlyph] = useState<'$' | '>'>('$')
  const [showCaret, setShowCaret] = useState(true)
  const [rippleKey, setRippleKey] = useState(0)

  useEffect(() => {
    if (reducedMotion || isTwoAgentsChecklist) {
      return
    }
    // Why: nobody watches an animation in a hidden window. `runOnVisible` is a
    // no-op so revealing the window resumes the queue instead of skipping an entry.
    return installWindowVisibilityInterval({
      run: () => setRunIdx((index) => (index + 1) % WORKBENCH_RUN_QUEUE.length),
      runOnVisible: () => {},
      intervalMs: WORKBENCH_RUN_TICK_MS
    })
  }, [isTwoAgentsChecklist, reducedMotion])

  useEffect(() => {
    if (reducedMotion) {
      return
    }
    let cancelled = false
    const timeouts: number[] = []
    const wait = (ms: number): Promise<void> =>
      new Promise((resolve) => {
        const id = window.setTimeout(resolve, ms)
        timeouts.push(id)
      })

    void runWorkbenchTerminalStoryboardSequence(variant, {
      isCancelled: () => cancelled,
      wait,
      setPhase,
      setCursorTarget,
      setRightTyped,
      setRightLines,
      setShowInputLine,
      setPromptGlyph,
      setShowCaret,
      pulseRipple: () => setRippleKey((key) => key + 1)
    })

    return () => {
      cancelled = true
      timeouts.forEach((id) => window.clearTimeout(id))
    }
  }, [variant, reducedMotion])

  return {
    phase,
    running: WORKBENCH_RUN_QUEUE[runIdx] ?? WORKBENCH_RUN_QUEUE[0],
    cursorTarget,
    rightTyped,
    rightLines,
    showInputLine,
    promptGlyph,
    showCaret,
    rippleKey
  }
}
