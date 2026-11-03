import { inspectRuntimeTerminalProcess } from '@/runtime/runtime-terminal-inspection'
import { pasteDraftToAgentPtyWhenReady } from '@/lib/agent-paste-draft'
import type { TuiAgent } from '../../../shared/tui-agent'
import {
  isAgentForegroundWrapperProcess,
  isExpectedAgentProcess
} from '../../../shared/agent-process-recognition'
import { isShellProcess } from '../../../shared/shell-process-detection'
import { noticeGeneratedInputFailure } from './launch-agent-paste-timeout-notice'
import { GENERATED_AGENT_INPUT_TIMEOUT_MS } from '../../../shared/generated-agent-input-readiness'

export async function sendFollowupPromptWhenAgentReady(args: {
  ptyId: string
  agent: TuiAgent
  expectedProcess: string
  prompt: string
}): Promise<boolean> {
  const { ptyId, agent, expectedProcess, prompt } = args
  const deadline = Date.now() + GENERATED_AGENT_INPUT_TIMEOUT_MS
  if (!(await waitForAgentForeground(ptyId, expectedProcess))) {
    noticeGeneratedInputFailure({ agent, text: prompt })
    return false
  }
  // Why: an agent in front may not read input yet; Kimi drops text typed before its composer is up (#10336).
  try {
    return await pasteDraftToAgentPtyWhenReady({
      ptyId,
      content: prompt,
      agent,
      submit: true,
      forcePaste: true,
      timeoutMs: Math.max(0, deadline - Date.now()),
      // Every frame needs this agent (or its wrapper with a child) still in front: one that exited
      // or was replaced during the wait never gets its prompt.
      requireConsumer: true
    })
  } catch {
    noticeGeneratedInputFailure({ agent, text: prompt, certainty: 'unconfirmed' })
    return false
  }
}

// Require positive readiness before sending delayed user/task text, or it could land in an arbitrary shell.
async function waitForAgentForeground(ptyId: string, expectedProcess: string): Promise<boolean> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (attempt > 0) {
      await new Promise((resolve) => globalThis.setTimeout(resolve, 150))
    }
    if (await agentHoldsPty(ptyId, expectedProcess, attempt >= 4)) {
      return true
    }
  }
  return false
}

async function agentHoldsPty(
  ptyId: string,
  expectedProcess: string,
  acceptWrapper: boolean
): Promise<boolean> {
  try {
    const process = await inspectRuntimeTerminalProcess(ptyId)
    const foreground = process.foregroundProcess?.toLowerCase() ?? ''
    // Wrapped agents may expose only python/node comm locally or over SSH; require a known wrapper plus a live non-shell child.
    return (
      isExpectedAgentProcess(foreground, expectedProcess) ||
      (acceptWrapper &&
        isAgentForegroundWrapperProcess(foreground) &&
        !isShellProcess(foreground) &&
        process.hasChildProcesses === true)
    )
  } catch {
    // Transient PTY inspection failures prove nothing.
    return false
  }
}
