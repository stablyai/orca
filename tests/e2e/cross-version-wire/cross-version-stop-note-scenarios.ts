import { describe, expect, it, vi } from 'vitest'
import { agentJournalItemKey } from '../../../src/shared/agent-session/journal/agent-session-journal-item-key'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../src/shared/agent-session/journal/agent-session-journal-types'
import { readTestJournalItems } from '../../../src/main/native-chat/agent-session-journal/journal-observation.test-support'
import { HISTORY_PAGE_CONTENT_BUDGET_BYTES } from '../../../src/main/native-chat/agent-session-wire/publication/history/agent-session-history-page-bounds'
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
      const { page, subscribe, events, delivered, reduce, render, turn, note, seed } = rig
      it('renders the derived page with the interrupted turn outside the page', async () => {
        await turn('interrupted')
        await note()
        const items = await readTestJournalItems(rig.journal)
        const stored = await rig.journal.reads.itemBody(noteId)
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
        expect(state.items[0]).toEqual({
          ...items.find((item) => item.itemId === noteId),
          body: ordinary
        })
        expect(await rig.journal.reads.itemBody(noteId)).toEqual(stored)
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
          const committed = rig.journal.cursor()
          // Select the ordinary turn batch, excluding an asynchronous initial note correction.
          const event = await vi.waitFor(() => {
            const found = events(replies).find(
              (event) =>
                event.type === 'batch' &&
                event.batch.cursor.epoch === committed.epoch &&
                event.batch.cursor.sequence === committed.sequence &&
                event.batch.items.some((item) => item.itemId === turnItemId)
            )
            expect(found).toBeDefined()
            return found
          })
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
          expect(await rig.journal.reads.itemBody(noteId)).toEqual(unconfirmed)
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
        await delivered(replies)
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
        await delivered(refreshed)
        state = reduce(state, refreshed)
        expect(render(state)).toEqual({ type: 'text', text: ordinary.text })
        expect(rig.journal.cursor()).toEqual(held)
      })
      it('replays to a released desktop and pages a fresh snapshot back to the dependent note', async () => {
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
        await delivered(caughtUp)
        expect(events(caughtUp).every((event) => event.type === 'batch')).toBe(true)
        expect(reduce(before, caughtUp).cursor).toEqual(rig.journal.cursor())
        const fresh = await subscribe(null)
        await delivered(fresh)
        let after = reduce(before, fresh)
        expect(events(fresh)[0]).toMatchObject({ type: 'snapshot', page: { hasOlder: true } })
        while (after.hasOlder && !after.items.some((item) => item.itemId === noteId)) {
          const requestedCursor = { epoch: after.epoch!, sequence: after.items[0]!.sequence }
          const older = await page({ direction: 'before', cursor: requestedCursor })
          after = rig.client.reduceStructuredAgentSession(after, {
            type: 'older-page',
            requestedCursor,
            page: older
          })
        }
        expect(render(after)).toEqual({ type: 'text', text: ordinary.text })
        expect(after.cursor).toEqual(rig.journal.cursor())
      })
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
        await delivered(replies)
        const after = reduce(before, replies)
        expect(after.items.some((item) => item.itemId === agentJournalItemKey(op))).toBe(false)
        expect(render(after)).toEqual({ type: 'text', text: ordinary.text })
      })
    }
  )
}
