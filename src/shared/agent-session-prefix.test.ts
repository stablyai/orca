import { describe, expect, it } from 'vitest'
import { selectAgentSessionPrefix, structuredForkEligibleItems } from './agent-session-prefix'
import type { AgentJournalRenderItem } from './agent-session-journal-types'
import {
  AGENT_SESSION_PREFIX_MAX_BYTES,
  AGENT_SESSION_PREFIX_MAX_ENTRIES,
  agentSessionPrefixWithinBounds
} from './agent-session-prefix-bounds'

/** Models a real journal: settlement TOMBSTONES a turn's lifecycle row, so a finished turn leaves
 *  none behind. Only a live turn has one, appended at turn start — before its answer. */
function items(provider: 'claude' | 'codex', running?: string): AgentJournalRenderItem[] {
  return ['a', 'b'].flatMap((turnId, turn) => {
    const rows: AgentJournalRenderItem[] = [
      {
        itemId:
          provider === 'codex' ? `codex:parent:${turnId}:0` : `claude:parent:${turnId}-prompt`,
        revision: 1,
        body: { kind: 'message', role: 'user', blocks: [] },
        sequence: turn * 3,
        observedAt: 1
      }
    ]
    if (running === turnId) {
      rows.push({
        itemId: `legacy:${provider}:parent:turn-lifecycle%3A${turnId}`,
        revision: 1,
        body: { kind: 'status', text: 'Working', turnLifecycle: { turnId, state: 'running' } },
        sequence: turn * 3 + 1,
        observedAt: 1
      })
    }
    rows.push({
      itemId: provider === 'codex' ? `codex:parent:${turnId}:1` : `claude:parent:${turnId}-answer`,
      revision: 1,
      body: { kind: 'message', role: 'assistant', blocks: [] },
      sequence: turn * 3 + 2,
      observedAt: 1
    })
    return rows
  })
}

describe('bounded conversation prefix', () => {
  it.each(['claude', 'codex'] as const)(
    'retains the selected %s turn inclusively and excludes the later turn',
    (provider) => {
      const history = items(provider)
      const handle =
        provider === 'codex'
          ? ({ provider, threadId: 'parent' } as const)
          : ({ provider, sessionId: 'parent', leafUuid: 'b-answer' } as const)
      const result = selectAgentSessionPrefix({
        items: history,
        itemId: history[1]!.itemId,
        handle,
        boundary: 'through'
      })
      expect(result).toMatchObject({ ok: true, throughId: provider === 'codex' ? 'a' : 'a-answer' })
      if (result.ok) {
        expect(result.retained.map((item) => item.itemId)).toEqual(
          history.slice(0, 2).map((item) => item.itemId)
        )
      }
      expect(structuredForkEligibleItems(history)).toEqual(
        new Set([history[1]!.itemId, history[3]!.itemId])
      )
    }
  )

  it('preserves rewind boundaries for a whole Codex turn and a Claude item', () => {
    for (const provider of ['claude', 'codex'] as const) {
      const history = items(provider)
      const handle =
        provider === 'codex'
          ? ({ provider, threadId: 'parent' } as const)
          : ({ provider, sessionId: 'parent', leafUuid: 'b-answer' } as const)
      const result = selectAgentSessionPrefix({
        items: history,
        itemId: history[3]!.itemId,
        handle,
        boundary: 'before'
      })
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.retained).toHaveLength(provider === 'codex' ? 2 : 3)
      }
    }
  })

  it('refuses missing, foreign, and unfinished targets', () => {
    const history = items('codex')
    const args = {
      items: history,
      itemId: history[1]!.itemId,
      handle: { provider: 'codex', threadId: 'parent' },
      boundary: 'through'
    } as const
    expect(selectAgentSessionPrefix({ ...args, itemId: 'missing' })).toMatchObject({
      ok: false,
      reason: 'invalid-target'
    })
    expect(
      selectAgentSessionPrefix({ ...args, handle: { provider: 'codex', threadId: 'foreign' } })
    ).toMatchObject({ ok: false, reason: 'invalid-target' })
    // A live turn: the running row is the one the producer actually leaves in the journal.
    const live = items('codex', 'b')
    expect(
      selectAgentSessionPrefix({ ...args, items: live, itemId: live[4]!.itemId })
    ).toMatchObject({ ok: false, reason: 'busy' })
    expect(structuredForkEligibleItems(live)).toEqual(new Set([live[1]!.itemId]))
  })

  it('inherits the retained entry and UTF-8 byte bounds', () => {
    expect(
      agentSessionPrefixWithinBounds(Array(AGENT_SESSION_PREFIX_MAX_ENTRIES + 1).fill(null))
    ).toBe(false)
    expect(agentSessionPrefixWithinBounds(['é'.repeat(AGENT_SESSION_PREFIX_MAX_BYTES / 2)])).toBe(
      false
    )
  })
})
