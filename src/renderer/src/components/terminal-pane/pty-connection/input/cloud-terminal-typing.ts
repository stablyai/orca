// A person typing in an Orca Cloud terminal counts as "I'm driving this workspace" for git as the
// sender: the control plane honors my GitHub identity in the sandbox only for a while after this
// desktop says so (noteCloudSend, throttled). Only this desktop's own keystrokes count: xterm's user-
// input provenance, never query replies, focus or mouse reports, replayed output, agent pastes or a
// resubscribe (none of those reach the input path as user input).
import { noteCloudSend } from '@/lib/cloud-message-sender'
import { isXtermMouseReport } from '../../input/pointer/terminal-pointer-input-sequences'
import { isPassiveTerminalInputReport } from '../../input/terminal-passive-input-report'

/** True when this input was typed by the person at this desktop (and so was reported). */
export function noteCloudTerminalTyping(
  environmentId: string | null | undefined,
  data: string,
  wasUserInput: boolean,
  report: (environmentId: string) => void = noteCloudSend
): boolean {
  if (!environmentId || !wasUserInput || !data) {
    return false
  }
  if (isXtermMouseReport(data) || isPassiveTerminalInputReport(data)) {
    return false
  }
  report(environmentId)
  return true
}
