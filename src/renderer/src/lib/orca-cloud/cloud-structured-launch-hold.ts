// CHAT-BANNERS (PR-B): a structured chat on an Orca Cloud host decides its launch the way a terminal
// pane's does (cloud-agent-credential-spawn-gate): an agent that isn't set up, or whose Orca-account
// sign-in expired with no key, holds on the strip at the top of the chat; the session is never
// created until the strip's Start (or Renew) releases it, so it can't start and fail at /login.
import { parseExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../../../shared/agent-session/view/structured-agent-session-projection'
import { isOrcaCloudExecutionHostId } from './orca-cloud-environment-id'
import {
  cloudAgentLaunchNeedsHold,
  holdCloudAgentLaunch,
  joinCloudAgentHold,
  useCloudAgentHold
} from './cloud-agent-launch-hold'
import {
  forgetHeldStructuredLaunch,
  readHeldStructuredLaunch,
  rememberHeldStructuredLaunch
} from './cloud-structured-held-launch-memory'

/**
 * The hold key of a structured chat, from its session id alone: a restored chat's tab id can carry a
 * suffix (`:history-N`), so its strip and composer read this key, never one built from the tab id.
 */
export function structuredCloudHoldKey(sessionId: string): string {
  return structuredAgentSessionPaneKey(structuredAgentSessionTabId(sessionId), sessionId)
}

/** Sessions whose launch joined a hold put back at startup (so Start doesn't launch them twice). */
const joinedSessions = new Set<string>()

/** Whether a launch joined this session's restored hold (read once). */
export function takeStructuredHoldJoined(sessionId: string): boolean {
  return joinedSessions.delete(sessionId)
}

/**
 * Resolves 'proceed' at once for anything but Claude or Codex on an Orca Cloud host whose account
 * is ready (or covered by a key); otherwise holds until the strip releases it. V3-01b: a chat held
 * before a restart joins the hold put back at startup, or holds again as restored (never starting
 * on a failed or covered read: it waits for the person's Start). In-session launches are unchanged.
 */
export async function holdStructuredCloudLaunch(intent: {
  sessionId: string
  worktreeId: string
  executionHostId: ExecutionHostId
  agent: string
}): Promise<'proceed' | 'cancel'> {
  const agent = intent.agent === 'claude' || intent.agent === 'codex' ? intent.agent : null
  if (!agent || !isOrcaCloudExecutionHostId(intent.executionHostId)) {
    return 'proceed'
  }
  const paneKey = structuredCloudHoldKey(intent.sessionId)
  const joined = joinCloudAgentHold(paneKey)
  if (joined) {
    joinedSessions.add(intent.sessionId)
    return joined
  }
  const restored = readHeldStructuredLaunch(intent.sessionId) !== null
  // A fresh "ready" read decides at once: no delay for a chat that can start.
  if (!restored && cloudAgentLaunchNeedsHold(agent) === false) {
    return 'proceed'
  }
  const host = parseExecutionHostId(intent.executionHostId)
  if (host?.kind === 'runtime') {
    rememberHeldStructuredLaunch({
      sessionId: intent.sessionId,
      worktreeId: intent.worktreeId,
      environmentId: host.environmentId,
      agent,
      createdAt: Date.now()
    })
  }
  return holdCloudAgentLaunch({ paneKey, agent, prompt: null, restored }).finally(() =>
    forgetHeldStructuredLaunch(intent.sessionId)
  )
}

/**
 * V3-01b: while a structured chat waits on its Orca Cloud hold, the host's "not signed in" verdict
 * is the hold's to explain (the strip and the composer hint), never the generic sign-in notice.
 * Any other chat keeps the host's verdict as it is.
 */
export function useCloudHeldChatUnavailable<T>(sessionId: string, unavailable: T): T | null {
  const held = useCloudAgentHold(structuredCloudHoldKey(sessionId)) !== null
  return held ? null : unavailable
}
