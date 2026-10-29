import {
  isAgentForegroundWrapperProcess,
  recognizeAgentProcess
} from '../../../shared/agent-process-recognition'
import { isShellProcess } from '../../../shared/shell-process-detection'
import type { TuiAgent } from '../../../shared/tui-agent'
import type { RuntimeTerminalProcessInspection } from '@/runtime/runtime-terminal-inspection'
import { isClientOnlyUnverifiableInspection } from '../../../shared/terminal-process-inspection'

function normalizeProcessName(processName: string | null): string | null {
  if (!processName) {
    return null
  }
  return processName.toLowerCase().replace(/\.exe$/, '')
}

export function isCodexForegroundProcess(processName: string | null): boolean {
  const normalized = normalizeProcessName(processName)
  if (!normalized) {
    return false
  }
  // Native node-pty names may include shipped Codex platform suffixes; match the Codex prefix.
  return normalized === 'codex' || normalized.startsWith('codex-')
}

/** Windows may report a deeper subagent instead of Codex. Use recorded launchAgent only with another agent/wrapper foreground; shell/pager/editor evidence must keep restart notices from swallowing unrelated keystrokes. */
export function isCodexRestartEligiblePane(args: {
  inspection: RuntimeTerminalProcessInspection
  launchAgent: TuiAgent | undefined
}): boolean {
  if (isClientOnlyUnverifiableInspection(args.inspection)) {
    return false
  }
  const { foregroundProcess, hasChildProcesses } = args.inspection
  if (isCodexForegroundProcess(foregroundProcess)) {
    return true
  }
  if (args.launchAgent !== 'codex' || foregroundProcess === null || !hasChildProcesses) {
    return false
  }
  if (isShellProcess(foregroundProcess)) {
    return false
  }
  return (
    recognizeAgentProcess(foregroundProcess) !== null ||
    isAgentForegroundWrapperProcess(foregroundProcess)
  )
}
