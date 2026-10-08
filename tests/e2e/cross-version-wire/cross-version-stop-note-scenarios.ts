import { describe, expect, it } from 'vitest'
import { agentJournalItemKey } from '../../../src/shared/agent-session-journal-item-key'
import { agentSessionFailureFact } from '../../../src/shared/agent-session-failure'
import { agentSessionFailureWords } from '../../../src/shared/agent-session-failure-words'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemBody
} from '../../../src/shared/agent-session-journal-types'
import { HISTORY_PAGE_CONTENT_BUDGET_BYTES } from '../../../src/main/native-chat/agent-session-wire/agent-session-history-page-bounds'
import {
  createReleasedStopNoteRig,
  noteId,
  noteIdentity,
  turnItemId,
  scope,
  ordinary,
  unconfirmed,
  type ScenarioPort
} from './cross-version-stop-note-test-rig'

export function describeReleasedStopNoteProjection(port: ScenarioPort): void {
  describe.each(['v1.4.219', 'v1.4.220'])(
    '%s client against the current host Stop projection',
    (ref) => {
      const rig = createReleasedStopNoteRig(port, ref)
      const { page, subscribe, events, reduce, render, turn, note, seed } = rig
      it('renders the derived page with the interrupted turn outside the page', async () => {
        await turn('interrupted')
        await note()
        const snapshot = rig.journal.snapshot()
        const stored = rig.journal.itemBody(noteId)
        const notePage = await page({ direction: 'tail', limit: 1 })
        expect(notePage.items.map((item) => item.itemId)).toEqual([noteId])
        const state = rig.client.reduceStructuredAgentSession(
          rig.client.EMPTY_STRUCTURED_AGENT_SESSION,
          {
            type: 'history-page',
            page: notePage
          }
        )
        expect(render(state)).toMatchObject({ type: 'text', text: ordinary.text })
        expect(state.items[0]).toEqual(snapshot.items.find((item) => item.itemId === noteId))
        expect(rig.journal.itemBody(noteId)).toBe(stored)
      })
      it.each([false, true])(
        'renders the same-revision note with a live turn end (lifecycle batch=%s)',
        async (batch) => {
          const before = await seed()
          expect(render(before)).toMatchObject({ failure: { kind: 'cancelUnconfirmed' } })
          const prior = before.items.find((item) => item.itemId === noteId)!
          const replies = await subscribe()
          replies.length = 0
          await turn('interrupted', batch)
          const event = events(replies).find(
            (event) =>
              event.type === 'batch' && event.batch.items.some((item) => item.itemId === noteId)
          )
          expect(event).toMatchObject({
            type: 'batch',
            batch: {
              items: expect.arrayContaining([
                expect.objectContaining({ itemId: turnItemId }),
                expect.objectContaining({ ...prior, body: ordinary })
              ]),
              removedItemIds: []
            }
          })
          const after = reduce(before, replies)
          expect(render(after)).toEqual({ type: 'text', text: ordinary.text })
          expect(rig.journal.itemBody(noteId)).toEqual(unconfirmed)
          const since = rig.journal.readSince(before.cursor!)
          expect(since).toMatchObject({
            ok: true,
            rows: [expect.objectContaining({ kind: batch ? 'lifecycle-batch' : 'item' })]
          })
        }
      )
      it('refreshes a non-upgrade stale page after an out-of-window live correction at the terminal cursor', async () => {
        await turn('running')
        await note()
        await rig.journal.appendItem(
          { provider: 'orca', clientMessageId: 'newer' },
          { kind: 'status', text: 'Newer' },
          { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
        )
        const tail = await page({ direction: 'tail', limit: 1 })
        let state = rig.client.reduceStructuredAgentSession(
          rig.client.EMPTY_STRUCTURED_AGENT_SESSION,
          {
            type: 'history-page',
            page: tail
          }
        )
        const requestedCursor = tail.window.nextCursor
        const stale = await page({ direction: 'before', cursor: requestedCursor, limit: 1 })
        const replies = await subscribe()
        replies.length = 0
        await turn('interrupted')
        state = reduce(state, replies)
        expect(state.items.some((item) => item.itemId === noteId)).toBe(false)
        state = rig.client.reduceStructuredAgentSession(state, {
          type: 'older-page',
          requestedCursor,
          page: stale
        })
        expect(render(state)).toMatchObject({ failure: { kind: 'cancelUnconfirmed' } })
        expect(state.cursor).toEqual(rig.journal.cursor())
        const held = rig.journal.cursor()
        const refreshed = await subscribe(held)
        state = reduce(state, refreshed)
        expect(render(state)).toEqual({ type: 'text', text: ordinary.text })
        expect(rig.journal.cursor()).toEqual(held)
      })
      it('catches up through byte-bounded pages without losing the dependent note or cursor', async () => {
        const before = await seed()
        const held = rig.journal.cursor()
        for (const clientMessageId of ['large-a', 'large-b']) {
          await rig.journal.appendItem(
            { provider: 'orca', clientMessageId },
            {
              kind: 'message',
              role: 'assistant',
              blocks: [
                {
                  type: 'text',
                  text: 'x'.repeat(Math.floor(HISTORY_PAGE_CONTENT_BUDGET_BYTES * 0.6))
                }
              ]
            },
            { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
          )
        }
        await turn('interrupted')
        const first = await page({ direction: 'after', cursor: held, limit: 3 })
        expect(first.hasNewer).toBe(true)
        const caughtUp = await subscribe(held)
        const after = reduce(before, caughtUp)
        expect(render(after)).toEqual({ type: 'text', text: ordinary.text })
        expect(after.cursor).toEqual(rig.journal.cursor())
        expect(events(caughtUp).filter((event) => event.type === 'batch').length).toBeGreaterThan(1)
      })
      it.each(['running', 'completed', 'unverifiable', 'missing', 'other-failure'] as const)(
        'keeps %s wording through the released page reader',
        async (state) => {
          if (state !== 'missing') {
            await turn(state === 'other-failure' ? 'interrupted' : state)
          }
          const body: AgentJournalItemBody =
            state === 'other-failure'
              ? {
                  kind: 'status',
                  ...agentSessionFailureWords(agentSessionFailureFact('providerExited'), {
                    surface: 'row'
                  })
                }
              : unconfirmed
          await note(body)
          const initial = await page({ direction: 'tail' })
          expect(initial.items.find((item) => item.itemId === noteId)?.body).toEqual(body)
        }
      )
      it('preserves removal when the operation note is re-keyed before the interrupted end', async () => {
        const op = { provider: 'orca', clientMessageId: 'stop:operation-1' } as const
        await rig.journal.appendItem(op, unconfirmed, {
          fence: 1,
          turnScope: AGENT_JOURNAL_THREAD_SCOPE
        })
        await turn('running')
        const initial = await page({ direction: 'tail' })
        const before = rig.client.reduceStructuredAgentSession(
          rig.client.EMPTY_STRUCTURED_AGENT_SESSION,
          {
            type: 'history-page',
            page: initial
          }
        )
        const held = rig.journal.cursor()
        await rig.journal.appendLifecycleBatch({
          settlementId: 're-key',
          fence: 1,
          mutations: [
            { kind: 'tombstone', identity: op },
            { kind: 'item', identity: noteIdentity, body: unconfirmed, turnScope: scope }
          ]
        })
        await turn('interrupted')
        const replies = await subscribe(held)
        const after = reduce(before, replies)
        expect(after.items.some((item) => item.itemId === agentJournalItemKey(op))).toBe(false)
        expect(render(after)).toEqual({ type: 'text', text: ordinary.text })
      })
    }
  )
}
