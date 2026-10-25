import { inspectRuntimeTerminalProcess } from '@/runtime/runtime-terminal-inspection'
import { sendRuntimePtyInputVerified } from '@/runtime/runtime-terminal-verified-input'
import {
  isAgentForegroundWrapperProcess,
  isExpectedAgentProcess
} from '../../../shared/agent-process-recognition'
import { isShellProcess } from '../../../shared/shell-process-detection'

export async function sendFollowupPromptWhenAgentReady(args: {
  ptyId: string
  expectedProcess: string
  prompt: string
}): Promise<boolean> {
  const { ptyId, expectedProcess, prompt } = args
  if (!(await waitForAgentForeground(ptyId, expectedProcess))) {
    return false
  }
  try {
    return await sendRuntimePtyInputVerified(ptyId, `${prompt}\r`, 'launch')
  } catch {
    return false
  }
}

// Require positive readiness before sending delayed user/task text, or it could land in an arbitrary shell.
async function waitForAgentForeground(ptyId: string, expectedProcess: string): Promise<boolean> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (attempt > 0) {
      await new Promise((resolve) => globalThis.setTimeout(resolve, 150))
    }
    try {
      const process = await inspectRuntimeTerminalProcess(ptyId)
      const foreground = process.foregroundProcess?.toLowerCase() ?? ''
      if (isExpectedAgentProcess(foreground, expectedProcess)) {
        return true
      }
      // Wrapped agents may expose only python/node comm locally or over SSH; require a known wrapper plus a live non-shell child.
      if (
        attempt >= 4 &&
        isAgentForegroundWrapperProcess(foreground) &&
        !isShellProcess(foreground) &&
        process.hasChildProcesses
      ) {
        return true
      }
    } catch {
      // Ignore transient PTY inspection failures and keep polling.
    }
  }
  return false
}
