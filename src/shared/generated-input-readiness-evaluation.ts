import type { TuiAgent } from './agent-launch/catalog/tui-agent'
import {
  TUI_AGENT_CONFIG,
  type DraftPasteReadySignal
} from './agent-launch/catalog/tui-agent-config'
import { showsAgentComposer } from './agent-input-dialog'
import { isExpectedAgentProcess } from './agent-process-recognition'
import { showsOpenCodeAgentRow } from './opencode-agent-row-scanner'
import { isKnownReadyPromptBody } from './terminal-wait-detection'
import {
  GENERATED_AGENT_INPUT_QUIET_MS,
  signalAllowsCompatibilityEvidence
} from './generated-agent-input-readiness'
import type { GeneratedInputProcess, GeneratedInputScreen } from './generated-agent-input-admission'
import type { RuledScreen } from './screen-input-veto'

/** One source's facts about a terminal at one moment. A source reports what it has, including
 *  that it has nothing; only the operation interprets them. */
export type GeneratedInputEvidence = {
  /** A current grid; 'unknown' when the source has none; null while its model catches up. */
  screen: GeneratedInputScreen
  process: GeneratedInputProcess
  /** The terminal's current bracketed-paste mode, null when the source cannot tell. */
  bracketedPaste: boolean | null
  /** Text the source itself holds without a grid (an older host's stream read): veto evidence. */
  tail?: string
}

/**
 * The one decision point for input nothing can observe (no grid, no screen from the host and no
 * text streamed since the agent's last handoff): 'deliver' keeps main's behavior and the common
 * pattern's unknown-endpoint rule, with any observed dialog or proven shell still refusing;
 * 'refuse' would wait out the budget and offer Copy. Delivering is the decided behavior.
 */
export const GENERATED_INPUT_BLIND_POLICY: 'deliver' | 'refuse' = 'deliver'

/** The screen admission judges: the grid (or null while the source's model catches up), else the
 *  operation's own streamed tail (veto evidence only), else unknown. */
export function admissionScreen(
  evidence: GeneratedInputEvidence,
  tail: string
): GeneratedInputScreen {
  if (evidence.screen !== 'unknown') {
    return evidence.screen
  }
  return tail.trim() ? tailScreen(tail) : 'unknown'
}

function tailScreen(tail: string): RuledScreen {
  return { lines: tail.split('\n'), alternateScreen: false }
}

/**
 * Startup with no grid (only an older host reports none): unknown input state is not a dialog.
 * With nothing observable the decided blind policy admits at once; a dialog-free streamed tail
 * admits on compatibility signals once quiet for the window the budget allows, as main's
 * expected-process fallback did. Either way the caller still checks the observed tail for a
 * dialog and the process for a shell or another agent; more dialog-free evidence never refuses
 * what less would admit. Agents whose composer paints before it takes input stay on their marker.
 */
export function admitsWithoutGrid(
  evidence: GeneratedInputEvidence,
  tail: string,
  agent: TuiAgent | null,
  signal: DraftPasteReadySignal,
  quietMs: number,
  requiredQuietMs: number
): boolean {
  if (evidence.screen !== 'unknown') {
    return false
  }
  if (!tail.trim()) {
    return GENERATED_INPUT_BLIND_POLICY === 'deliver'
  }
  return (
    agent !== 'codex' && signalAllowsCompatibilityEvidence(signal) && quietMs >= requiredQuietMs
  )
}

/** Positive evidence on the current grid that the agent reads input now. Idle rules that settle
 *  only after quiet read the measured quiet, so a late observer of an idle Codex or OpenCode grid
 *  still sees it ready; agents whose composer paints before it takes input never pass on a glyph. */
export function gridShowsReadyComposer(
  evidence: GeneratedInputEvidence,
  agent: TuiAgent | null,
  signal: DraftPasteReadySignal,
  quietMs: number
): boolean {
  const { screen, process } = evidence
  if (!screen || screen === 'unknown') {
    return false
  }
  const text = screen.lines.join('\n')
  const outputClock = quietMs < GENERATED_AGENT_INPUT_QUIET_MS
  if (isKnownReadyPromptBody(text, agent, () => screen.lines, outputClock)) {
    return true
  }
  const pasteMode = evidence.bracketedPaste === true
  // OpenCode's submit-ready sign, its stream scanner's agent row, read from the painted grid.
  if (
    agent !== null &&
    TUI_AGENT_CONFIG[agent].submitPasteReadySignal === 'opencode-agent-row' &&
    pasteMode &&
    screen.alternateScreen &&
    showsOpenCodeAgentRow(screen.lines)
  ) {
    return true
  }
  // A painted composer counts once the expected agent is proven in front, so a streaming turn
  // still takes input; a shell prompt glyph never does.
  return (
    signalAllowsCompatibilityEvidence(signal) &&
    pasteMode &&
    process.known &&
    agent !== null &&
    isExpectedAgentProcess(process.foreground, TUI_AGENT_CONFIG[agent].expectedProcess) &&
    showsAgentComposer(text)
  )
}
