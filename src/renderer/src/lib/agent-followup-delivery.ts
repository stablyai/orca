import {
  inspectRuntimeTerminalProcess,
  sendRuntimePtyInputVerified
} from '@/runtime/runtime-terminal-inspection'
import { isExpectedAgentProcess } from '../../../shared/agent-process-recognition'
import type { GlobalSettings } from '../../../shared/types'

type RuntimeOwnerSettings = Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined
// Why: stalled remote process inspection must not extend delayed-startup
// cleanup beyond the existing follow-up readiness window.
const FOLLOWUP_READY_TIMEOUT_MS = 4500
const FOLLOWUP_READY_POLL_MS = 150

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
  const deadline = Date.now() + FOLLOWUP_READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    try {
      const process = await withDeadline(
        inspectRuntimeTerminalProcess(settings, ptyId),
        Math.max(0, deadline - Date.now())
      )
      if (!process) {
        return false
      }
      const foreground = process.foregroundProcess?.toLowerCase() ?? ''
      if (isExpectedAgentProcess(foreground, expectedProcess)) {
        return true
      }
    } catch {
      // Ignore transient PTY inspection failures and keep polling.
    }
    const delayMs = Math.min(FOLLOWUP_READY_POLL_MS, Math.max(0, deadline - Date.now()))
    if (delayMs > 0) {
      await new Promise((resolve) => globalThis.setTimeout(resolve, delayMs))
    }
  }
  return false
}

function withDeadline<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  if (timeoutMs <= 0) {
    return Promise.resolve(null)
  }
  return new Promise((resolve, reject) => {
    const timer = globalThis.setTimeout(() => resolve(null), timeoutMs)
    promise.then(
      (value) => {
        globalThis.clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        globalThis.clearTimeout(timer)
        reject(error)
      }
    )
  })
}
