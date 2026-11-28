import { beforeEach, expect, it, vi } from 'vitest'
import type { DiffComment } from '../../../../../shared/file-review/diff-comment-types'
import { createStore, host, note, OWNER, shown } from './diff-comment-delivery-cleanup.test-fixture'

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), dismiss: vi.fn() }
}))

beforeEach(() => {
  vi.clearAllMocks()
  host.gate = null
})

// Counts id reads on the delivered snapshots, the input cleanup checks every shown and saved note against.
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
