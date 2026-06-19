import type { AutoSwitchRateLimitAgent } from '../../../shared/agent-rate-limit-detection'
import type { GlobalSettings } from '../../../shared/types'
import { isExpectedAgentProcess } from '../../../shared/agent-process-recognition'
import {
  inspectRuntimeTerminalProcess,
  sendRuntimePtyInputVerified
} from '@/runtime/runtime-terminal-inspection'

const AGENT_STOP_ATTEMPTS = 3
const AGENT_STOP_WAIT_MS = 1400
const AGENT_RESUME_WAIT_MS = 6000
const AGENT_READY_INPUT_DELAY_MS = 800

/** Uses the browser timer so renderer tests and Electron share the same scheduling path. */
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

/** Matches the foreground process against the expected resumed provider command. */
function isForegroundAgent(
  foregroundProcess: string | null | undefined,
  agent: AutoSwitchRateLimitAgent,
  expectedProcess: string
): boolean {
  if (isExpectedAgentProcess(foregroundProcess, expectedProcess)) {
    return true
  }
  const normalized = foregroundProcess?.trim().toLowerCase() ?? ''
  return agent === 'codex' ? normalized.startsWith('codex-') : normalized === 'claude'
}

/** Inspects the PTY without mutating it, so stop/resume decisions stay terminal-safe. */
async function isAgentStillForeground(args: {
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined
  ptyId: string
  agent: AutoSwitchRateLimitAgent
  expectedProcess: string
}): Promise<boolean> {
  const process = await inspectRuntimeTerminalProcess(args.settings, args.ptyId)
  return isForegroundAgent(process.foregroundProcess, args.agent, args.expectedProcess)
}

/** Exits only the foreground agent process by sending Ctrl+C to the existing PTY. */
export async function stopForegroundAgent(args: {
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined
  ptyId: string
  agent: AutoSwitchRateLimitAgent
  expectedProcess: string
}): Promise<boolean> {
  if (!(await isAgentStillForeground(args))) {
    return true
  }

  for (let attempt = 0; attempt < AGENT_STOP_ATTEMPTS; attempt += 1) {
    const sent = await sendRuntimePtyInputVerified(args.settings, args.ptyId, '\x03')
    if (!sent) {
      return false
    }
    await wait(AGENT_STOP_WAIT_MS)
    if (!(await isAgentStillForeground(args))) {
      return true
    }
  }

  return false
}

/** Waits for the resumed provider process to take foreground control of the same PTY. */
export async function waitForResumedAgent(args: {
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined
  ptyId: string
  agent: AutoSwitchRateLimitAgent
  expectedProcess: string
}): Promise<boolean> {
  const deadline = Date.now() + AGENT_RESUME_WAIT_MS
  while (Date.now() < deadline) {
    if (await isAgentStillForeground(args)) {
      return true
    }
    await wait(150)
  }
  return false
}

/** Leaves a short settle window before sending the continuation prompt to the TUI. */
export async function waitForAgentReadyInput(): Promise<void> {
  await wait(AGENT_READY_INPUT_DELAY_MS)
}
