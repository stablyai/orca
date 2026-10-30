import { describe, expect, it } from 'vitest'
import type {
  WorkbenchAnimatedVisualVariant,
  WorkbenchAnimationPhase,
  WorkbenchCursorTarget,
  WorkbenchTerminalLine
} from './workbench-terminal-storyboard-state'
import {
  runWorkbenchTerminalStoryboardSequence,
  type WorkbenchTerminalSequenceControls
} from './workbench-terminal-storyboard-sequence'

describe('workbench terminal storyboard sequence', () => {
  it.each([
    {
      variant: 'tour' as const,
      durationMs: 14_660,
      finalLines: [
        { kind: 'submitted-command', text: 'claude' },
        { kind: 'session-started' },
        { kind: 'submitted-prompt', text: 'review src/auth for missing error handling' },
        { kind: 'response-skeleton', widthPct: 72, withGlyph: true },
        { kind: 'response-skeleton', widthPct: 88, withGlyph: false },
        { kind: 'response-skeleton', widthPct: 64, withGlyph: false },
        { kind: 'response-skeleton', widthPct: 78, withGlyph: false }
      ] satisfies readonly WorkbenchTerminalLine[]
    },
    {
      variant: 'two-agents-checklist' as const,
      durationMs: 15_080,
      finalLines: [
        { kind: 'submitted-command', text: 'codex' },
        { kind: 'session-started' },
        { kind: 'submitted-prompt', text: 'fix failing checkout test' },
        { kind: 'agent-action', action: 'Read', target: 'checkout.test.ts' },
        { kind: 'agent-action', action: 'Grep', target: 'timeout checkout' },
        { kind: 'agent-action', action: 'Edit', target: 'src/checkout.ts', working: true }
      ] satisfies readonly WorkbenchTerminalLine[]
    }
  ])('preserves the $variant phases and cycle duration', async (expected) => {
    const result = await runSingleCycle(expected.variant, expected.durationMs)

    expect(result.phases.map((phase) => phase.kind)).toEqual([
      'idle',
      'hover',
      'right-click',
      'menu-open',
      'menu-active',
      'menu-click',
      'split-empty',
      'split-active'
    ])
    expect(result.cursorTargets.map((target) => target.kind)).toEqual([
      'hidden',
      'pane',
      'split-row',
      'hidden'
    ])
    expect(result.ripples).toBe(2)
    expect(result.waits.reduce((total, duration) => total + duration, 0)).toBe(expected.durationMs)
    expect(result.lines).toEqual(expected.finalLines)
  })
})

async function runSingleCycle(
  variant: WorkbenchAnimatedVisualVariant,
  durationMs: number
): Promise<{
  phases: WorkbenchAnimationPhase[]
  cursorTargets: WorkbenchCursorTarget[]
  waits: number[]
  lines: readonly WorkbenchTerminalLine[]
  ripples: number
}> {
  let cancelled = false
  let elapsedMs = 0
  let lines: readonly WorkbenchTerminalLine[] = []
  let ripples = 0
  const phases: WorkbenchAnimationPhase[] = []
  const cursorTargets: WorkbenchCursorTarget[] = []
  const waits: number[] = []
  const controls: WorkbenchTerminalSequenceControls = {
    isCancelled: () => cancelled,
    wait: (ms) => {
      waits.push(ms)
      elapsedMs += ms
      cancelled = elapsedMs >= durationMs
      return Promise.resolve()
    },
    setPhase: (phase) => phases.push(phase),
    setCursorTarget: (target) => cursorTargets.push(target),
    setRightTyped: () => {},
    setRightLines: (update) => {
      lines = typeof update === 'function' ? update(lines) : update
    },
    setShowInputLine: () => {},
    setPromptGlyph: () => {},
    setShowCaret: () => {},
    pulseRipple: () => {
      ripples += 1
    }
  }

  await runWorkbenchTerminalStoryboardSequence(variant, controls)
  return { phases, cursorTargets, waits, lines, ripples }
}
