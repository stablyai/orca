import { expect, it } from 'vitest'
import { makeSnapshot, ENV, WT } from '../testing/web-session-tabs-sync.test-fixture'
import { waitForChatLinkSessionTabs } from './remote-runtime-session-tabs-inflight'

it('shares a pending reply with a replacement link while fencing a new pairing', async () => {
  const original = new AbortController()
  const current = new AbortController()
  const oldSnapshot = makeSnapshot([], { snapshotVersion: 5 })
  const newSnapshot = makeSnapshot([], { snapshotVersion: 1 })
  const oldReply = Promise.withResolvers<{ snapshot: typeof oldSnapshot }>()
  const newReply = Promise.withResolvers<{ snapshot: typeof newSnapshot }>()
  const scope = { registration: { revision: 1 }, connectionGeneration: 0, timeoutMs: 5_000 }
  const target = { environmentId: ENV, worktreeId: WT, scope }
  const first = waitForChatLinkSessionTabs({
    ...target,
    signal: original.signal,
    load: async (hasWaiters) => {
      expect(hasWaiters()).toBe(true)
      return oldReply.promise
    }
  })
  const superseded = new Error('The user navigated away')
  const canceled = expect(first).rejects.toBe(superseded)
  original.abort(superseded)
  const reopened = waitForChatLinkSessionTabs({
    ...target,
    signal: current.signal,
    load: async () => {
      throw new Error('A replacement click should join the pending read')
    }
  })
  const rePaired = {
    ...target,
    scope: { ...scope, registration: { revision: 1 } },
    signal: current.signal,
    load: () => newReply.promise
  }
  const newPairing = waitForChatLinkSessionTabs(rePaired)

  oldReply.resolve({ snapshot: oldSnapshot })
  await canceled
  const oldAnswer = await reopened
  expect(oldAnswer.snapshot).toBe(oldSnapshot)

  const secondForNewPairing = waitForChatLinkSessionTabs(rePaired)
  newReply.resolve({ snapshot: newSnapshot })
  const newAnswer = await newPairing
  expect(newAnswer.snapshot).toBe(newSnapshot)
  expect(newAnswer.receivedFrame).toBeGreaterThan(oldAnswer.receivedFrame)
  await expect(secondForNewPairing).resolves.toBe(newAnswer)
})
