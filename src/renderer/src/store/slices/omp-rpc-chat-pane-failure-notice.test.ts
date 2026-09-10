import { describe, expect, it } from 'vitest'
import { createTestStore } from './store-test-helpers'

const PANE_KEY = 'tab-1:leaf-1'

function acquiredPane() {
  const store = createTestStore()
  store.getState().setOmpRpcChatPaneStatus(PANE_KEY, 'acquired')
  return store
}

function entry(store: ReturnType<typeof createTestStore>) {
  return store.getState().ompRpcChatOwnershipByPaneKey[PANE_KEY]
}

/** What a consumer reads at render time and names back when it clears: the
 *  occurrence id, not the wording -- two failures can read identically. */
function readNotice(store: ReturnType<typeof createTestStore>) {
  return { id: entry(store).commandFailureId ?? 0 }
}

describe('OMP RPC pane failure notice attribution', () => {
  it('marks a superseded notice as such, so the consumer can rank it', () => {
    // A mounted composer holds its live failure notice in local state, which
    // leaves the durable field free. The store cannot see that, so the notice
    // it writes has to carry whose failure it describes and let the surface
    // holding the live notice apply the precedence.
    const store = acquiredPane()
    const supersededGeneration = entry(store).generation
    store.getState().setOmpRpcChatPaneStatus(PANE_KEY, 'idle')
    store.getState().setOmpRpcChatPaneStatus(PANE_KEY, 'acquired')
    expect(entry(store).generation).toBeGreaterThan(supersededGeneration)

    store.getState().reportOmpRpcChatPaneMessageFailure(PANE_KEY, supersededGeneration)

    expect(entry(store).commandFailureMessage).toBe(
      "Message was not sent: the pane's agent session was replaced first."
    )
    expect(entry(store).commandFailureSuperseded).toBe(true)
  })

  it('marks the live session\'s own failure as not superseded', () => {
    const store = acquiredPane()

    store.getState().reportOmpRpcChatPaneMessageFailure(PANE_KEY, entry(store).generation)

    expect(entry(store).commandFailureMessage).toBe('Message could not be sent to the agent.')
    expect(entry(store).commandFailureSuperseded).toBe(false)
  })

  it('clears the mark with the notice, so a stale flag cannot outrank the next one', () => {
    const store = acquiredPane()
    const supersededGeneration = entry(store).generation
    store.getState().setOmpRpcChatPaneStatus(PANE_KEY, 'idle')
    store.getState().setOmpRpcChatPaneStatus(PANE_KEY, 'acquired')
    store.getState().reportOmpRpcChatPaneMessageFailure(PANE_KEY, supersededGeneration)

    store.getState().clearOmpRpcChatPaneCommandFailure(PANE_KEY, readNotice(store))

    expect(entry(store).commandFailureMessage).toBeNull()
    expect(entry(store).commandFailureSuperseded).toBe(false)
  })

  it('keeps a newer failure the consumer never read', () => {
    // The consumer captures the notice at render and clears it from a passive
    // effect a tick later. Another in-flight send can report into the same row
    // in between, and clearing whatever is there by then erases a notice
    // nobody has seen -- so the clear names what it consumed.
    const store = acquiredPane()
    const generation = entry(store).generation
    store.getState().reportOmpRpcChatPaneCommandFailure(PANE_KEY, '/help', generation)
    const consumed = readNotice(store)

    store.getState().reportOmpRpcChatPaneMessageFailure(PANE_KEY, generation)
    store.getState().clearOmpRpcChatPaneCommandFailure(PANE_KEY, consumed)

    expect(entry(store).commandFailureMessage).toBe('Message could not be sent to the agent.')
    expect(entry(store).commandFailureSuperseded).toBe(false)
  })

  it('keeps the live failure that replaced a superseded one under the consumer', () => {
    // The other order: the consumer read the rebind wording, then the live
    // session's own refusal took the field. Clearing blind would drop the
    // notice that actually names this session's failure.
    const store = acquiredPane()
    const generation = entry(store).generation
    store.getState().setOmpRpcChatPaneStatus(PANE_KEY, 'idle')
    store.getState().setOmpRpcChatPaneStatus(PANE_KEY, 'acquired')
    store.getState().reportOmpRpcChatPaneMessageFailure(PANE_KEY, generation)
    const consumed = readNotice(store)
    expect(entry(store).commandFailureSuperseded).toBe(true)

    store.getState().reportOmpRpcChatPaneMessageFailure(PANE_KEY, entry(store).generation)
    store.getState().clearOmpRpcChatPaneCommandFailure(PANE_KEY, consumed)

    expect(entry(store).commandFailureMessage).toBe('Message could not be sent to the agent.')
    expect(entry(store).commandFailureSuperseded).toBe(false)
  })

  it('keeps the mark across an unrelated status change', () => {
    // The row is rebuilt field by field on a status write; dropping the mark
    // there would silently re-promote a superseded notice to a live one.
    const store = acquiredPane()
    const supersededGeneration = entry(store).generation
    store.getState().setOmpRpcChatPaneStatus(PANE_KEY, 'idle')
    store.getState().setOmpRpcChatPaneStatus(PANE_KEY, 'acquired')
    store.getState().reportOmpRpcChatPaneMessageFailure(PANE_KEY, supersededGeneration)

    store.getState().setOmpRpcChatPaneStatus(PANE_KEY, 'faulted')

    expect(entry(store).commandFailureSuperseded).toBe(true)
  })

  it('keeps a second identical failure the consumer never read', () => {
    // Both sends fail the same way, so the wording is byte-identical and the
    // superseded flag matches too. Only the occurrence id separates them, and
    // without it the stale clear takes the second, still-unread failure with
    // the first -- two failed sends, one notice.
    const store = acquiredPane()
    const generation = entry(store).generation
    store.getState().reportOmpRpcChatPaneMessageFailure(PANE_KEY, generation)
    const consumed = readNotice(store)

    store.getState().reportOmpRpcChatPaneMessageFailure(PANE_KEY, generation)
    expect(entry(store).commandFailureId).not.toBe(consumed.id)
    store.getState().clearOmpRpcChatPaneCommandFailure(PANE_KEY, consumed)

    expect(entry(store).commandFailureMessage).toBe('Message could not be sent to the agent.')
  })

  it('keeps a second superseded failure the consumer never read', () => {
    // Two sends from the same replaced session fail after the pane rebound, so
    // both notices are superseded and read identically. Yielding to the first
    // would leave the second with no occurrence id of its own, and the
    // consumer's pending clear -- which names the first -- would then empty the
    // row: two failed sends, no notice at all.
    const store = acquiredPane()
    const supersededGeneration = entry(store).generation
    store.getState().setOmpRpcChatPaneStatus(PANE_KEY, 'idle')
    store.getState().setOmpRpcChatPaneStatus(PANE_KEY, 'acquired')
    store.getState().reportOmpRpcChatPaneMessageFailure(PANE_KEY, supersededGeneration)
    const consumed = readNotice(store)

    store.getState().reportOmpRpcChatPaneCommandFailure(PANE_KEY, '/help', supersededGeneration)
    expect(entry(store).commandFailureId).not.toBe(consumed.id)
    store.getState().clearOmpRpcChatPaneCommandFailure(PANE_KEY, consumed)

    expect(entry(store).commandFailureMessage).toBe(
      "Command /help was not sent: the pane's agent session was replaced first."
    )
    expect(entry(store).commandFailureSuperseded).toBe(true)
  })

  it('keeps the occurrence id across an unrelated status change', () => {
    // The row is rebuilt field by field on a status write. Losing the id there
    // would strand the notice: no consumer could ever name it back to clear it.
    const store = acquiredPane()
    store.getState().reportOmpRpcChatPaneMessageFailure(PANE_KEY, entry(store).generation)
    const consumed = readNotice(store)

    store.getState().setOmpRpcChatPaneStatus(PANE_KEY, 'faulted')
    store.getState().clearOmpRpcChatPaneCommandFailure(PANE_KEY, consumed)

    expect(entry(store).commandFailureMessage).toBeNull()
    expect(entry(store).commandFailureId).toBeNull()
  })
})
