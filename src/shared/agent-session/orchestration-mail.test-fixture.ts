import type { NativeChatMessage } from '../native-chat/native-chat-types'
import type { AgentMessageSource } from './agent-session-message-source'

// Recorded current mail envelope keeps browser fixtures independent of server imports.
export function orchestrationMailFixture({
  body = 'The result is ready.'
}: { body?: string } = {}): NativeChatMessage & { from: AgentMessageSource } {
  const text = `──── From: TERM_WORKER (term_worker) (question) ────
Subject: Review complete
${body}
[Reply: orca orchestration reply --id msg_review --body "..."]
────────────────────────────────────────────────────────────`
  const content = { subject: [62, 77] as const, body: [78, 78 + body.length] as const }
  return {
    id: 'msg_review',
    role: 'user',
    source: 'transcript',
    timestamp: 1,
    blocks: [{ type: 'text', text }],
    from: {
      kind: 'agent',
      senders: [
        {
          name: 'Review worker',
          agent: 'codex',
          relation: 'worker',
          party: { address: 'term_worker', terminalHandle: 'term_worker', orcaSessionId: null }
        }
      ],
      orchestration: {
        message: 'mail-notice',
        mailbox: 'run:run_review',
        dispatchId: null,
        messages: [{ messageId: 'msg_review', runId: 'run_review', from: 'term_worker', content }]
      }
    }
  }
}
