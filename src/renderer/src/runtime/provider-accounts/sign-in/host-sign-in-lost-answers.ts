import { classifyTerminalProcessInspectionFailure } from '../../../../../shared/terminal/pty/lifecycle/terminal-process-inspection'

/** Only a lost answer is worth asking again; a refusal or a re-paired server is final. */
export function isLostHostAnswer(error: unknown): boolean {
  const reason = classifyTerminalProcessInspectionFailure(error)
  return reason === 'timeout' || reason === 'transport_loss'
}
