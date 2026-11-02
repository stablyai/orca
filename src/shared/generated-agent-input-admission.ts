import type { TuiAgent } from './tui-agent'
import { TUI_AGENT_CONFIG } from './tui-agent-config'
import { findAgentInputDialogIndex } from './agent-input-dialog'
import { readScreenInputVeto, type RuledScreen } from './screen-input-veto'
import {
  isAgentForegroundWrapperProcess,
  isExpectedAgentProcess,
  recognizeAgentProcess
} from './agent-process-recognition'
import { isShellProcess } from './shell-process-detection'

/** What could be read about the process consuming the PTY. Unknown (an old host, Windows) is never
 *  a refusal; a proven shell or another agent is. */
export type GeneratedInputProcess =
  | { known: false }
  | { known: true; foreground: string | null; hasChildProcesses: boolean }

/** A grid (or, legacy, a stream tail) is checked for dialogs; 'unknown' means nothing could be
 *  observed and is not a dialog; null means the host's model has not caught up yet. */
export type GeneratedInputScreen = RuledScreen | 'unknown' | null

export type GeneratedInputObservation = {
  agent: TuiAgent | null | undefined
  screen: GeneratedInputScreen
  process: GeneratedInputProcess
  /** Admission rests on compatibility quiet rather than a positive composer marker. */
  quiet: boolean
  /** Text this operation already typed; its rows are composer content, not dialog controls. */
  typedText?: string
}

/** The current screen gives input to a dialog or overlay, or has not caught up yet. */
export function screenRefusesGeneratedInput(
  agent: TuiAgent | null | undefined,
  screen: GeneratedInputScreen,
  typedText = ''
): boolean {
  if (screen === 'unknown') {
    return false
  }
  return (
    screen === null ||
    readScreenInputVeto(agent, () => screen) === true ||
    findAgentInputDialogIndex(screen.lines.join('\n'), typedText) !== null
  )
}

/** The one admission rule for every generated write, on the host or in the legacy adapter. */
export function admitsGeneratedInput(observation: GeneratedInputObservation): boolean {
  const { agent, process } = observation
  if (screenRefusesGeneratedInput(agent, observation.screen, observation.typedText)) {
    return false
  }
  const foreground = process.known ? process.foreground : null
  if (!process.known || !foreground) {
    return true
  }
  if (isShellProcess(foreground)) {
    return false
  }
  // A positive composer marker keeps main's delivery whatever the process is called (agents share
  // binaries); quiet alone proves nothing, so it needs the expected agent or a wrapper with a child.
  if (!observation.quiet) {
    return true
  }
  const expected = agent
    ? isExpectedAgentProcess(foreground, TUI_AGENT_CONFIG[agent].expectedProcess)
    : recognizeAgentProcess(foreground) !== null
  return expected || (isAgentForegroundWrapperProcess(foreground) && process.hasChildProcesses)
}
