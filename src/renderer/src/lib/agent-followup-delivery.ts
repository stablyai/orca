import {
  inspectRuntimeTerminalProcess,
  sendRuntimePtyInputVerified
} from '@/runtime/runtime-terminal-inspection'
import { isExpectedAgentProcess } from '../../../shared/agent-process-recognition'
import type { GlobalSettings } from '../../../shared/types'

type RuntimeOwnerSettings = Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined

export async function sendFollowupPromptWhenAgentReady(args: {
  ptyId: string
  expectedProcess: string
  prompt: string
  settings: RuntimeOwnerSettings
}): Promise<boolean> {
  const { ptyId, expectedProcess, prompt, settings } = args
  if (!(await waitForAgentForeground(ptyId, expectedProcess, settings))) {
    return false
  }
  try {
    return await sendRuntimePtyInputVerified(settings, ptyId, `${prompt}\r`)
  } catch {
    return false
  }
}

// Why: delayed follow-ups must not type into an arbitrary shell. Require a
// positive expected-process match before writing user/task text to the PTY.
async function waitForAgentForeground(
  ptyId: string,
  expectedProcess: string,
  settings: RuntimeOwnerSettings
): Promise<boolean> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (attempt > 0) {
      await new Promise((resolve) => globalThis.setTimeout(resolve, 150))
    }
    try {
      const process = await inspectRuntimeTerminalProcess(settings, ptyId)
      const foreground = process.foregroundProcess?.toLowerCase() ?? ''
      if (isExpectedAgentProcess(foreground, expectedProcess)) {
        return true
      }
    } catch {
      // Ignore transient PTY inspection failures and keep polling.
    }
  }
  return false
}
