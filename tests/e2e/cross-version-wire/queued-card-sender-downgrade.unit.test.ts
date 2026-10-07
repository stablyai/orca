import { expect, test } from 'vitest'
import type { AgentMessageSource } from '../../../src/shared/agent-session-message-source'
import type {
  AgentSessionQueuedMessage,
  AgentSessionQueuePause
} from '../../../src/shared/agent-session-wire'
import { projectQueuedMessageCards } from '../../../src/renderer/src/components/native-chat/structured-agent-session-queued-cards'
import { importReleaseCheckoutModule, materializeReleaseCheckout } from './release-checkout'

// A person's Stop no longer holds another agent's mail, so a client labels a card whose body names
// its sender (`from`) as waiting rather than paused. No wire change: `from` already rides on each
// card's body. A build without this change labels every card under a pause as before, and this build
// reads a card from a host without `from` (one that also predates this rule, so holds mail) as the
// person's. The main commit this change branched from, which has the queue and `from`; move it to
// the newest release that has both and predates this change. A baseline holding this change tests
// no downgrade.
const BASELINE_REF = '0c96550ee9ab44c86b770518cc0deb56a0c130d0'
const CARDS = 'src/renderer/src/components/native-chat/structured-agent-session-queued-cards.ts'
const STOPPED: AgentSessionQueuePause = { reason: 'stopped' }
const AGENT_FROM: AgentMessageSource = {
  kind: 'agent',
  senders: [],
  orchestration: { message: 'mail-notice', mailbox: 'run:r1', dispatchId: null, messages: [] }
}

function card(messageId: string, position: number, from?: AgentMessageSource) {
  return {
    messageId,
    position,
    body: {
      kind: 'message' as const,
      role: 'user' as const,
      blocks: [{ type: 'text' as const, text: messageId }],
      ...(from ? { from } : {})
    },
    state: 'waiting' as const
  } satisfies AgentSessionQueuedMessage
}

type OlderProjection = (
  queuedMessages: readonly unknown[],
  submissions: readonly unknown[],
  session: { hasPendingPrompt: boolean; queuePaused?: boolean }
) => readonly { messageId: string; hold: string }[]

async function olderProjection(): Promise<OlderProjection> {
  const checkout = await materializeReleaseCheckout(BASELINE_REF)
  const cards = await importReleaseCheckoutModule(checkout, CARDS)
  const project = cards.projectQueuedMessageCards
  if (typeof project !== 'function') {
    throw new Error('the pinned build exports no projectQueuedMessageCards')
  }
  return (queuedMessages, submissions, session) => project(queuedMessages, submissions, session)
}

test("an older client reads this host's cards, mail included, as paused under a person's Stop, as before", async () => {
  const project = await olderProjection()
  const held = project([card('typed', 1), card('mail', 2, AGENT_FROM)], [], {
    hasPendingPrompt: false,
    queuePaused: true
  })
  expect(held.map((entry) => [entry.messageId, entry.hold])).toEqual([
    ['typed', 'queue-paused'],
    ['mail', 'queue-paused']
  ])
})

test("this client reads a card whose body names no sender as the person's", () => {
  const held = projectQueuedMessageCards([card('typed', 1), card('unnamed', 2)], [], {
    hasPendingPrompt: false,
    queuePause: STOPPED
  })
  expect(held.map((entry) => entry.hold)).toEqual(['queue-paused', 'queue-paused'])
})
