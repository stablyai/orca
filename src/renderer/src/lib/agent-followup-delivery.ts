import {
  inspectRuntimeTerminalProcess,
  sendRuntimePtyInputVerified
} from '@/runtime/runtime-terminal-inspection'
import {
  isAgentForegroundWrapperProcess,
  isExpectedAgentProcess
} from '../../../shared/agent-process-recognition'
import { isShellProcess } from '../../../shared/shell-process-detection'
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
// positive readiness signal before writing user/task text to the PTY.
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
      // Why: interpreter-wrapped agents (aider, mistral-vibe are pip console
      // scripts) surface a python/node foreground comm, so the exact-name check
      // never matches — locally when the ps-table resolver can't pin the child,
      // and over SSH when the relay falls back to the bare interpreter name. If
      // the foreground is a known agent wrapper (not a shell) with a live
      // non-shell child, the agent has taken over the PTY and can accept input.
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
