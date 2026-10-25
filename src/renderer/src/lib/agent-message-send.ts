import type { ActiveAgentNotesSendResult } from './active-agent-note-send-result'
import type { AgentMessageTarget } from './agent-message-target'
import { sendNotesToActiveAgentSession } from './active-agent-note-send'
import { relaunchFailedStructuredAgentSessionWithMessage } from './structured-agent-session-launch-message'
import { getStructuredAgentSessionLaunchLifecycle } from './agent-session/launch/structured-agent-session-launch-registry'
import { sendStructuredAgentSessionMessage } from '@/components/native-chat/structured-agent-session-message-sender'
import { structuredAgentSessionTargetForTab } from '@/runtime/structured-agent-session-owner'
import { useAppStore } from '@/store'

export type { AgentMessageTarget } from './agent-message-target'

export async function sendMessageToAgent(args: {
  worktreeId: string
  target: AgentMessageTarget
  prompt: string
}): Promise<ActiveAgentNotesSendResult> {
  const { target, worktreeId } = args
  const prompt = args.prompt.trim()
  if (!prompt) {
    return { status: 'empty', code: 'empty' }
  }
  if (target.kind === 'terminal') {
    return sendNotesToActiveAgentSession({
      worktreeId,
      prompt,
      noteTarget: { tabId: target.tabId, leafId: target.leafId }
    })
  }
  const state = useAppStore.getState()
  const tab = (state.unifiedTabsByWorktree[worktreeId] ?? []).find(
    (candidate) =>
      candidate.contentType === 'agent-session' && candidate.entityId === target.sessionId
  )
  const runtime = tab ? structuredAgentSessionTargetForTab(state, tab) : null
  if (!runtime) {
    return { status: 'not-writable', code: 'session-send-refused' }
  }
  const lifecycle = getStructuredAgentSessionLaunchLifecycle(worktreeId, target.sessionId)
  // A chat still starting takes no send yet: the notes wait, as its composer would.
  if (lifecycle === 'pending' || lifecycle === 'visibility-unknown') {
    return { status: 'not-ready', code: 'session-send-refused' }
  }
  const relaunched = relaunchFailedStructuredAgentSessionWithMessage(
    worktreeId,
    target.sessionId,
    prompt,
    { callerKeepsText: true }
  )
  if (relaunched) {
    const result = await relaunched
    return result.delivered
      ? { status: 'sent' }
      : result.unconfirmed
        ? { status: 'unconfirmed', code: 'runtime-unverifiable' }
        : { status: 'not-writable', code: 'session-send-refused' }
  }
  const sent = sendStructuredAgentSessionMessage({
    sessionId: target.sessionId,
    target: runtime,
    text: prompt,
    callerKeepsText: true
  })
  // The chat's own send is still out: the notes wait, as its composer would.
  if (!sent) {
    return { status: 'not-ready', code: 'session-send-refused' }
  }
  const outcome = await sent.outcome
  return outcome === 'recorded'
    ? { status: 'sent' }
    : outcome === 'unconfirmed'
      ? { status: 'unconfirmed', code: 'runtime-unverifiable' }
      : { status: 'not-writable', code: 'session-send-refused' }
}
