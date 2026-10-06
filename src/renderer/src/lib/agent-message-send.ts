import type { ActiveAgentNotesSendResult } from './active-agent-note-send-result'
import type { AgentMessageTarget } from './agent-message-target'
import { sendNotesToActiveAgentSession } from './active-agent-note-send'
import { relaunchFailedStructuredAgentSessionForMessage } from './structured-agent-session-launch'
import { appendStructuredAgentSessionOutboxMessage } from '@/components/native-chat/structured-agent-session-outbox-storage'

export type { AgentMessageTarget } from './agent-message-target'

/** The one way a picked agent is sent a message, whatever transport it runs on. */
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
  // Why: queued on the chat's own outbox, as its composer does, so the message shows in the
  // chat and a failed send stays there with Retry. The open chat delivers it.
  if (!appendStructuredAgentSessionOutboxMessage(target.sessionId, prompt)) {
    return { status: 'not-writable', code: 'session-outbox-unsaved' }
  }
  relaunchFailedStructuredAgentSessionForMessage(worktreeId, target.sessionId)
  return { status: 'sent' }
}
