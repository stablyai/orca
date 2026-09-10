import { describe, expect, it } from 'vitest'
import {
  selectAgentSessionPrefix,
  structuredForkEligibleItems,
  structuredForkTurnAnchors
} from './agent-session-prefix'
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
        body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: `${turnId} ask` }] },
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
      body: {
        kind: 'message',
        role: 'assistant',
        blocks: [{ type: 'text', text: `${turnId} answer` }]
      },
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
      expect(structuredForkEligibleItems(structuredForkTurnAnchors(history))).toEqual(
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
    expect(structuredForkEligibleItems(structuredForkTurnAnchors(live))).toEqual(
      new Set([live[1]!.itemId])
    )
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

function journal(bodies: AgentJournalRenderItem['body'][]): AgentJournalRenderItem[] {
  return bodies.map((body, index) => ({
    itemId: `codex:parent:a:${index}`,
    revision: 1,
    body,
    sequence: index,
    observedAt: 1
  }))
}

/** A turn whose assistant side is text -> tool call -> text: the shape a normal turn actually has.
 *
 *  Tool activity is a `tool-call` BODY, which is what both live translators emit — never an
 *  assistant message whose blocks happen to all be tool blocks. Only the bridge-era importer
 *  produces that, so a fixture built from it tests a journal Orca cannot make. */
function multiRowTurn(): AgentJournalRenderItem[] {
  return journal([
    { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Ask' }] },
    { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'Looking' }] },
    { kind: 'tool-call', name: 'read', input: {}, state: 'completed' },
    { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'Answered' }] }
  ])
}

function withRunningTurn(items: AgentJournalRenderItem[], turnId = 'a'): AgentJournalRenderItem[] {
  return [
    ...items,
    {
      itemId: `legacy:codex:parent:turn-lifecycle%3A${turnId}`,
      revision: 1,
      body: { kind: 'status', text: 'Working', turnLifecycle: { turnId, state: 'running' } },
      sequence: items.length,
      observedAt: 1
    }
  ]
}

describe('one fork action per turn', () => {
  it('exposes a single action for a turn that spans several assistant rows', () => {
    const history = multiRowTurn()
    expect(structuredForkEligibleItems(structuredForkTurnAnchors(history))).toEqual(
      new Set(['codex:parent:a:3'])
    )
  })

  it('resolves every row of that turn to the SAME target, so two clicks cannot mint two forks', () => {
    const anchors = structuredForkTurnAnchors(multiRowTurn())
    // The dedupe that matters is here, not in eligibility: the fork command keys its replay table
    // by the resolved target, so sibling rows join one attempt however they were surfaced.
    expect(anchors.get('codex:parent:a:1')).toBe('codex:parent:a:3')
    expect(anchors.get('codex:parent:a:3')).toBe('codex:parent:a:3')
    expect(new Set(anchors.values()).size).toBe(1)
  })

  it('never anchors on a trailing tool-only row, which the transcript folds away', () => {
    const history = multiRowTurn()
    // Drop the closing prose: the turn now ends in tool activity, which the transcript folds into
    // the row above and draws no row of its own, so it could carry no control.
    const folded = history.slice(0, 3)
    expect(structuredForkEligibleItems(structuredForkTurnAnchors(folded))).toEqual(
      new Set(['codex:parent:a:1'])
    )
  })

  it('never anchors on a row that draws no control, even though it draws SOMETHING', () => {
    // An assistant row of pure images renders its attachments but no control cluster, so anchoring
    // there costs the turn its only fork affordance in silence. Reachable via Claude: Codex always
    // prepends a text block. `isToolOnlyBlockSet` calls this row "drawn" and picks it.
    const withTrailingImage = journal([
      { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Ask' }] },
      { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'Answered' }] },
      {
        kind: 'message',
        role: 'assistant',
        blocks: [{ type: 'image-ref', path: '/tmp/shot.png', alt: 'screenshot' }]
      }
    ])
    const anchors = structuredForkTurnAnchors(withTrailingImage)
    expect(structuredForkEligibleItems(anchors)).toEqual(new Set(['codex:parent:a:1']))
    expect(anchors.get('codex:parent:a:2')).toBe('codex:parent:a:1')
  })

  it('gives a turn with nothing drawable NO anchor rather than a phantom one', () => {
    // The `?? turn.at(-1)` fallback anchored here anyway, and the transcript then drew nothing.
    const imageOnlyTurn = journal([
      { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Ask' }] },
      {
        kind: 'message',
        role: 'assistant',
        blocks: [{ type: 'image-ref', path: '/tmp/shot.png', alt: 'screenshot' }]
      },
      { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Again' }] },
      { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'Answered' }] }
    ])
    const anchors = structuredForkTurnAnchors(imageOnlyTurn)
    expect(anchors.get('codex:parent:a:1')).toBeUndefined()
    expect(structuredForkEligibleItems(anchors)).toEqual(new Set(['codex:parent:a:3']))
  })

  it('still refuses an all-tool-block assistant message, which only a legacy import can produce', () => {
    const imported = journal([
      { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Ask' }] },
      { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'Answered' }] },
      {
        kind: 'message',
        role: 'assistant',
        blocks: [{ type: 'tool-call', name: 'read', input: {} }]
      }
    ])
    expect(structuredForkEligibleItems(structuredForkTurnAnchors(imported))).toEqual(
      new Set(['codex:parent:a:1'])
    )
  })

  it('keeps the whole turn out while it is still running', () => {
    expect(structuredForkTurnAnchors(withRunningTurn(multiRowTurn())).size).toBe(0)
  })

  it('keeps offering SETTLED turns while a LATER turn runs, exactly as the host does', () => {
    // The host refuses only the live turn as `busy` and serves every settled one, so nothing may
    // withhold a settled turn's action merely because the session is working.
    const live = withRunningTurn(
      [
        ...multiRowTurn(),
        {
          itemId: 'codex:parent:b:0',
          revision: 1,
          body: {
            kind: 'message' as const,
            role: 'user' as const,
            blocks: [{ type: 'text' as const, text: 'Next' }]
          },
          sequence: 10,
          observedAt: 1
        }
      ],
      'b'
    )
    expect(structuredForkEligibleItems(structuredForkTurnAnchors(live))).toEqual(
      new Set(['codex:parent:a:3'])
    )
  })
})
