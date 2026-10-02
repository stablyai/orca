import { beforeAll, describe, expect, it } from 'vitest'
import {
  importReleaseCheckoutModule,
  materializeReleaseCheckout,
  resolveBaselineReleaseRef
} from './release-checkout'
import type { AgentJournalRenderItem } from '../../../src/shared/agent-session-journal-types'
import type { AgentSessionTurnActivity } from '../../../src/shared/agent-session-wire'

/**
 * A new host also publishes the live turn activity while only reasoning is open: empty words plus
 * an optional `reasoning` field. No wire shape is new, but the content is (Rule 3 of the remote
 * wire rules), so the released client's own reader must draw no line for it, exactly as for no
 * activity, and must read words that arrive beside the field as it always did.
 */
const SUITE_TIMEOUT_MS = 180_000

type OldBuild = {
  selectStructuredAgentTurnActivity: (
    items: readonly AgentJournalRenderItem[],
    turnId: string | null,
    providerActivity?: AgentSessionTurnActivity | null
  ) => { kind: string; text: string } | null
}

let old: OldBuild

beforeAll(async () => {
  const checkout = await materializeReleaseCheckout(resolveBaselineReleaseRef())
  const activity = await importReleaseCheckoutModule(
    checkout,
    'src/shared/native-chat-turn-activity.ts'
  )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the release exports the reader by this name; a missing one fails the test.
  old = activity as unknown as OldBuild
}, SUITE_TIMEOUT_MS)

const RUNNING_TURN: AgentJournalRenderItem = {
  itemId: 'turn',
  sequence: 1,
  revision: 1,
  observedAt: 1,
  body: { kind: 'turn', turnId: 'turn-1', state: 'running' }
}
const REASONING = { session: true, subagents: ['task-1'] }

describe("a released client reading this host's open-reasoning activity", () => {
  it('draws no line for reasoning alone, as for no activity at all', () => {
    expect(
      old.selectStructuredAgentTurnActivity([RUNNING_TURN], 'turn-1', {
        turnId: 'turn-1',
        text: '',
        reasoning: REASONING
      })
    ).toBeNull()
    expect(old.selectStructuredAgentTurnActivity([RUNNING_TURN], 'turn-1', null)).toBeNull()
  })

  it('reads the words beside it unchanged', () => {
    expect(
      old.selectStructuredAgentTurnActivity([RUNNING_TURN], 'turn-1', {
        turnId: 'turn-1',
        text: 'Thinking through the request',
        reasoning: REASONING
      })
    ).toEqual({ kind: 'description', text: 'Thinking through the request' })
  })
})
