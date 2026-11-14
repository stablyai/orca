import {
  WORKBENCH_CLAUDE_COMMAND,
  WORKBENCH_CODEX_COMMAND,
  WORKBENCH_CODEX_PROMPT,
  WORKBENCH_RESPONSE_WIDTHS,
  WORKBENCH_REVIEW_PROMPT,
  type WorkbenchAnimatedVisualVariant,
  type WorkbenchAnimationPhase,
  type WorkbenchCursorTarget,
  type WorkbenchTerminalLine
} from './workbench-terminal-storyboard-state'

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
const CHECKLIST_FINAL_HOLD_MS = 3800

type WorkbenchTerminalLinesUpdate =
  | readonly WorkbenchTerminalLine[]
  | ((lines: readonly WorkbenchTerminalLine[]) => readonly WorkbenchTerminalLine[])

export type WorkbenchTerminalSequenceControls = {
  isCancelled: () => boolean
  wait: (ms: number) => Promise<void>
  setPhase: (phase: WorkbenchAnimationPhase) => void
  setCursorTarget: (target: WorkbenchCursorTarget) => void
  setRightTyped: (text: string) => void
  setRightLines: (update: WorkbenchTerminalLinesUpdate) => void
  setShowInputLine: (shown: boolean) => void
  setPromptGlyph: (glyph: '$' | '>') => void
  setShowCaret: (shown: boolean) => void
  pulseRipple: () => void
}

async function pause(
  controls: WorkbenchTerminalSequenceControls,
  durationMs: number
): Promise<boolean> {
  await controls.wait(durationMs)
  return controls.isCancelled()
}

async function typeIntoRightPane(
  controls: WorkbenchTerminalSequenceControls,
  text: string,
  perCharacterMs: number
): Promise<boolean> {
  for (let index = 1; index <= text.length; index += 1) {
    if (controls.isCancelled()) {
      return true
    }
    controls.setRightTyped(text.slice(0, index))
    if (await pause(controls, perCharacterMs)) {
      return true
    }
  }
  return false
}

export async function runWorkbenchTerminalStoryboardSequence(
  variant: WorkbenchAnimatedVisualVariant,
  controls: WorkbenchTerminalSequenceControls
): Promise<void> {
  const isTwoAgentsChecklist = variant === 'two-agents-checklist'
  while (!controls.isCancelled()) {
    controls.setPhase({ kind: 'idle' })
    controls.setCursorTarget({ kind: 'hidden' })
    controls.setRightTyped('')
    controls.setRightLines([])
    controls.setShowInputLine(true)
    controls.setPromptGlyph('$')
    controls.setShowCaret(true)
    if (await pause(controls, PRE_HOVER_MS)) {
      return
    }

    controls.setPhase({ kind: 'hover' })
    controls.setCursorTarget({ kind: 'pane' })
    if (await pause(controls, HOVER_HOLD_MS)) {
      return
    }

    controls.setPhase({ kind: 'right-click' })
    controls.pulseRipple()
    if (await pause(controls, RIGHT_CLICK_MS)) {
      return
    }
    controls.setPhase({ kind: 'menu-open' })
    if (await pause(controls, MENU_SETTLE_MS)) {
      return
    }

    controls.setPhase({ kind: 'menu-active' })
    controls.setCursorTarget({ kind: 'split-row' })
    if (await pause(controls, MENU_HOLD_MS)) {
      return
    }

    controls.setPhase({ kind: 'menu-click' })
    controls.pulseRipple()
    if (await pause(controls, MENU_CLICK_MS)) {
      return
    }
    controls.setCursorTarget({ kind: 'hidden' })
    if (await pause(controls, POST_CLICK_MS)) {
      return
    }
    controls.setPhase({ kind: 'split-empty' })
    if (await pause(controls, POST_SPLIT_MS)) {
      return
    }

    controls.setPhase({ kind: 'split-active' })
    const agentCommand = isTwoAgentsChecklist ? WORKBENCH_CODEX_COMMAND : WORKBENCH_CLAUDE_COMMAND
    if (await typeIntoRightPane(controls, agentCommand, TYPE_PER_CHAR_MS)) {
      return
    }
    if (await pause(controls, POST_CLAUDE_TYPE_MS)) {
      return
    }

    controls.setShowInputLine(false)
    controls.setRightLines((lines) => [
      ...lines,
      { kind: 'submitted-command', text: agentCommand },
      { kind: 'session-started' }
    ])
    if (await pause(controls, SESSION_HEADER_MS)) {
      return
    }
    controls.setShowInputLine(true)
    controls.setPromptGlyph('>')
    controls.setRightTyped('')
    if (await pause(controls, PRE_PROMPT_TYPE_MS)) {
      return
    }

    const taskPrompt = isTwoAgentsChecklist ? WORKBENCH_CODEX_PROMPT : WORKBENCH_REVIEW_PROMPT
    if (await typeIntoRightPane(controls, taskPrompt, PROMPT_PER_CHAR_MS)) {
      return
    }
    if (await pause(controls, POST_PROMPT_TYPE_MS)) {
      return
    }

    controls.setShowCaret(false)
    controls.setRightLines((lines) => [...lines, { kind: 'submitted-prompt', text: taskPrompt }])
    controls.setShowInputLine(false)
    if (await pause(controls, POST_SUBMIT_MS)) {
      return
    }
    controls.setRightLines((lines) => [...lines, { kind: 'thinking' }])
    if (await pause(controls, THINKING_MS)) {
      return
    }

    if (isTwoAgentsChecklist) {
      controls.setRightLines((lines) => [
        ...lines.filter((line) => line.kind !== 'thinking'),
        { kind: 'agent-action', action: 'Read', target: 'checkout.test.ts' }
      ])
      if (await pause(controls, RESPONSE_GAP_MS)) {
        return
      }
      controls.setRightLines((lines) => [
        ...lines,
        { kind: 'agent-action', action: 'Grep', target: 'timeout checkout' }
      ])
      if (await pause(controls, RESPONSE_GAP_LATER_MS)) {
        return
      }
      controls.setRightLines((lines) => [
        ...lines,
        { kind: 'agent-action', action: 'Edit', target: 'src/checkout.ts', working: true }
      ])
      if (await pause(controls, CHECKLIST_FINAL_HOLD_MS)) {
        return
      }
      continue
    }

    controls.setRightLines((lines) => [
      ...lines.filter((line) => line.kind !== 'thinking'),
      { kind: 'response-skeleton', widthPct: WORKBENCH_RESPONSE_WIDTHS[0], withGlyph: true }
    ])
    if (await pause(controls, RESPONSE_GAP_MS)) {
      return
    }
    controls.setRightLines((lines) => [
      ...lines,
      { kind: 'response-skeleton', widthPct: WORKBENCH_RESPONSE_WIDTHS[1], withGlyph: false }
    ])
    if (await pause(controls, RESPONSE_GAP_LATER_MS)) {
      return
    }
    controls.setRightLines((lines) => [
      ...lines,
      { kind: 'response-skeleton', widthPct: WORKBENCH_RESPONSE_WIDTHS[2], withGlyph: false }
    ])
    if (await pause(controls, RESPONSE_GAP_LATER_MS)) {
      return
    }
    controls.setRightLines((lines) => [
      ...lines,
      { kind: 'response-skeleton', widthPct: WORKBENCH_RESPONSE_WIDTHS[3], withGlyph: false }
    ])
    if (await pause(controls, FINAL_HOLD_MS)) {
      return
    }
  }
}
