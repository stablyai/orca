import { describe, expect, it, vi } from 'vitest'

import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../src/shared/agent-session/journal/agent-session-journal-types'
import {
  createReleasedStopNoteRig,
  noteId,
  turnItemId,
  ordinary,
  type ScenarioPort
} from './cross-version-stop-note-test-rig'

export function describeReleasedStopNoteProjection(port: ScenarioPort): void {
  describe.each(['v1.4.219', 'v1.4.220'])(
    '%s client against the current host Stop projection',
    (ref) => {
      const rig = createReleasedStopNoteRig(port, ref)
      const { page, subscribe, events, delivered, reduce, render, turn, note, seed } = rig

      it('renders the same-revision note with a live turn end', async () => {
        const before = await seed()
        expect(render(before)).toMatchObject({ failure: { kind: 'cancelUnconfirmed' } })
        const prior = before.items.find((item) => item.itemId === noteId)!
        const replies = await subscribe()
        replies.length = 0
        await turn('interrupted', true)
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
      })
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
    }
  )
}
