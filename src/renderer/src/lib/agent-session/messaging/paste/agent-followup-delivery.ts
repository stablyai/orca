import { inspectRuntimeTerminalProcess } from '@/runtime/hosted-terminals/inspection/runtime-terminal-process-inspection'
import { pasteDraftToAgentPtyWhenReady } from '@/lib/agent-session/messaging/paste/agent-paste-draft'
import type { TuiAgent } from '../../../../../../shared/agent-launch/catalog/tui-agent'
import {
  isAgentForegroundProcess,
  isAgentForegroundWrapperProcess
} from '../../../../../../shared/agent-status/process/agent-process-recognition'
import { isShellProcess } from '../../../../../../shared/agent-status/process/shell-process-detection'

export async function sendFollowupPromptWhenAgentReady(args: {
  ptyId: string
  agent: TuiAgent
  prompt: string
}): Promise<boolean> {
  const { ptyId, agent, prompt } = args
  if (!(await waitForAgentForeground(ptyId, agent))) {
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
      // An agent that exited during the readiness wait must not have its prompt pasted into the shell.
      beforePaste: () => agentHoldsPty(ptyId, agent, true)
    })
  } catch {
    return false
  }
}

// Require positive readiness before sending delayed user/task text, or it could land in an arbitrary shell.
async function waitForAgentForeground(ptyId: string, agent: TuiAgent): Promise<boolean> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (attempt > 0) {
      await new Promise((resolve) => globalThis.setTimeout(resolve, 150))
    }
    if (await agentHoldsPty(ptyId, agent, attempt >= 4)) {
      return true
    }
  }
  return false
}

async function agentHoldsPty(
  ptyId: string,
  agent: TuiAgent,
  acceptWrapper: boolean
): Promise<boolean> {
  try {
    const process = await inspectRuntimeTerminalProcess(ptyId)
    const foreground = process.foregroundProcess?.toLowerCase() ?? ''
    // Wrapped agents may expose only python/node comm locally or over SSH; require a known wrapper plus a live non-shell child.
    return (
      isAgentForegroundProcess(foreground, agent) ||
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
