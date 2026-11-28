import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { DiffComment } from '../../../../../shared/file-review/diff-comment-types'
import {
  cleanupCalls,
  createStore,
  host,
  note,
  OWNER,
  shown
} from './diff-comment-delivery-cleanup.test-fixture'

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), dismiss: vi.fn() }
}))

beforeEach(() => {
  // Only Date: the host fake and write queue settle through real promises.
  vi.useFakeTimers({ now: 1_000_000, toFake: ['Date'] })
  vi.clearAllMocks()
  host.ignoresCleanup = false
  host.gate = null
})

afterEach(() => {
  vi.useRealTimers()
})

// Counts id reads on copies of the notes, so a scan of every note shows up as reads.
function countedSnapshots(notes: DiffComment[]): {
  snapshots: DiffComment[]
  idReads: () => number
} {
  let reads = 0
  const snapshots = notes.map((n) => {
    const copy = { ...n }
    const { id } = copy
    Object.defineProperty(copy, 'id', {
      enumerable: true,
      get: () => {
        reads += 1
        return id
      }
    })
    return copy
  })
  return { snapshots, idReads: () => reads }
}

async function clearAll(count: number, hostKeepsNotes: boolean) {
  const notes = Array.from({ length: count }, (_, i) => note(`n${i}`))
  const store = createStore(notes)
  host.ignoresCleanup = hostKeepsNotes
  const { snapshots, idReads } = countedSnapshots(notes)
  const ok = await store.getState().clearDeliveredDiffComments(OWNER, snapshots)
  return { ok, reads: idReads(), left: shown(store) }
}

// PR #51560 (STA-19463): cleanup after a large send scanned every snapshot per note and stalled the renderer.
it.each([300, 3000])(
  'removes %i delivered notes with id reads linear in the count',
  async (count) => {
    const { ok, reads, left } = await clearAll(count, false)
    expect(ok).toBe(true)
    expect(left).toEqual([])
    expect(reads).toBeLessThanOrEqual(count * 20)
  }
)

// PR #51560: checking the host's reply scanned every snapshot per note it kept, here the unsent ones.
it.each([300, 3000])(
  'checks a host reply keeping %i unsent notes with id reads linear in the count',
  async (count) => {
    const unsent = Array.from({ length: count }, (_, i) => note(`u${i}`))
    const delivered = Array.from({ length: count }, (_, i) => note(`n${i}`))
    const store = createStore([...unsent, ...delivered])
    const { snapshots, idReads } = countedSnapshots(delivered)
    expect(await store.getState().clearDeliveredDiffComments(OWNER, snapshots)).toBe(true)
    expect(shown(store).map((n) => n.id)).toEqual(unsent.map((n) => n.id))
    expect(idReads()).toBeLessThanOrEqual(count * 20)
  }
)

// PR #51560: the fallback when the host keeps the notes (verify the reply, then mark sent) had the same scans.
it.each([300, 3000])(
  'marks %i kept notes sent with id reads linear in the count',
  async (count) => {
    const { ok, reads, left } = await clearAll(count, true)
    expect(ok).toBe(false)
    expect(left.filter((n) => n.sentAt)).toHaveLength(count)
    expect(reads).toBeLessThanOrEqual(count * 20)
  }
)

// PR #51560: a repeated success report for notes already being removed must not index every shown note.
it.each([300, 3000])(
  'skips %i shown notes on a repeated report while removal runs',
  async (count) => {
    const { snapshots: stored, idReads } = countedSnapshots(
      Array.from({ length: count }, (_, i) => note(`n${i}`))
    )
    const store = createStore(stored)
    host.ignoresCleanup = false
    const release = Promise.withResolvers<void>()
    host.gate = async (updates) => {
      if (updates.deliveredDiffCommentSnapshots) {
        await release.promise
      }
    }
    const delivered = [note('n0')]
    const first = store.getState().clearDeliveredDiffComments(OWNER, delivered)
    const before = idReads()
    // Synchronous through the in-flight skip: no await runs before it returns.
    const repeated = store.getState().clearDeliveredDiffComments(OWNER, delivered)
    expect(idReads() - before).toBe(0)
    release.resolve()
    expect(await Promise.all([first, repeated])).toEqual([true, true])
    expect(shown(store)).toHaveLength(count - 1)
  }
)

// PR #42482: some launch paths report one delivery success twice; the host gets one removal command.
it('asks the host once when one success is reported twice', async () => {
  const a = note('a')
  const store = createStore([a])
  const first = store.getState().clearDeliveredDiffComments(OWNER, [a])
  const second = store.getState().clearDeliveredDiffComments(OWNER, [a])
  expect(await Promise.all([first, second])).toEqual([true, true])
  // A report after the note is gone needs no host work either.
  expect(await store.getState().clearDeliveredDiffComments(OWNER, [a])).toBe(true)
  expect(cleanupCalls()).toBe(1)
  expect(shown(store)).toEqual([])
  expect(host.notes).toEqual([])
})

// PR #51560: a one-note report (inline note menus) must not index every shown note before queueing cleanup.
it.each([300, 3000])(
  'admits one reported note among %i shown with constant reads',
  async (count) => {
    const { snapshots: stored, idReads } = countedSnapshots(
      Array.from({ length: count }, (_, i) => note(`n${i}`))
    )
    const store = createStore(stored)
    const delivered = [note('n0')]
    // Admission is synchronous; host work runs on the queue after this returns.
    const clearing = store.getState().clearDeliveredDiffComments(OWNER, delivered)
    expect(idReads()).toBeLessThanOrEqual(4)
    expect(await clearing).toBe(true)
    expect(shown(store)).toHaveLength(count - 1)
  }
)
