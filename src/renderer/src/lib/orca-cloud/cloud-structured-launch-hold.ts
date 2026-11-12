// CHAT-BANNERS (PR-B): a structured chat on an Orca Cloud host decides its launch the way a terminal
// pane's does (cloud-agent-credential-spawn-gate): an agent that isn't set up, or whose Orca-account
// sign-in expired with no key, holds on the strip at the top of the chat; the session is never
// created until the strip's Start (or Renew) releases it, so it can't start and fail at /login.
import type { ExecutionHostId } from '../../../../shared/execution-host'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../../../shared/agent-session/view/structured-agent-session-projection'
import { isOrcaCloudExecutionHostId } from './orca-cloud-environment-id'
import { cloudAgentLaunchNeedsHold, holdCloudAgentLaunch } from './cloud-agent-launch-hold'

/** The hold key of a structured chat: its pane key, which its strip and composer read. */
export function structuredCloudHoldKey(sessionId: string): string {
  return structuredAgentSessionPaneKey(structuredAgentSessionTabId(sessionId), sessionId)
}

/**
 * Resolves 'proceed' at once for anything but Claude or Codex on an Orca Cloud host whose account
 * is ready (or covered by a key); otherwise holds until the strip releases it.
 */
export async function holdStructuredCloudLaunch(intent: {
  sessionId: string
  executionHostId: ExecutionHostId
  agent: string
}): Promise<'proceed' | 'cancel'> {
  const agent = intent.agent === 'claude' || intent.agent === 'codex' ? intent.agent : null
  if (!agent || !isOrcaCloudExecutionHostId(intent.executionHostId)) {
    return 'proceed'
  }
  // A fresh "ready" read decides at once: no delay for a chat that can start.
  if (cloudAgentLaunchNeedsHold(agent) === false) {
    return 'proceed'
  }
  return holdCloudAgentLaunch({
    paneKey: structuredCloudHoldKey(intent.sessionId),
    agent,
    prompt: null
  })
}
