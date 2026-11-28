import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  diffCommentSendKey,
  isNoteInFlight
} from '@/components/notes/delivery/notes-send-in-flight'
import {
  createStore,
  host,
  note,
  OWNER,
  shown,
  WT
} from './diff-comment-delivery-cleanup.test-fixture'

type ToastOptions = { action?: { label: string; onClick: () => void } }
const toastError = vi.hoisted(() => vi.fn<(message: string, options?: ToastOptions) => void>())
const toastDismiss = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: toastError, dismiss: toastDismiss }
}))

describe('removing delivered review notes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    host.ignoresCleanup = false
    host.gate = null
  })

  it('keeps a note the host did not remove out of Send, and Remove removes it', async () => {
    const a = note('a')
    const store = createStore([a])
    host.ignoresCleanup = true

    expect(await store.getState().clearDeliveredDiffComments(OWNER, [a])).toBe(false)

    // Not reported as removed: the note stays, marked sent, so Send does not offer it again.
    expect(shown(store).map((n) => n.id)).toEqual(['a'])
    expect(shown(store)[0].sentAt).toBeGreaterThan(0)
    expect(isNoteInFlight(diffCommentSendKey(OWNER, a))).toBe(false)
    await vi.waitFor(() => expect(host.notes[0]?.sentAt).toBeGreaterThan(0))
    const options = toastError.mock.calls[0][1]
    expect(toastError.mock.calls[0][0]).toBe("Notes sent, but they're still in the list.")
    expect(options?.action?.label).toBe('Remove')

    host.ignoresCleanup = false
    options?.action?.onClick()
    await vi.waitFor(() => expect(shown(store)).toEqual([]))
    expect(host.notes).toEqual([])
    expect(toastDismiss).toHaveBeenCalled()
  })

  it('leaves a note edited after delivery sendable when removal fails', async () => {
    const a = note('a')
    const store = createStore([a])
    host.ignoresCleanup = true
    const release = Promise.withResolvers<void>()
    host.gate = async (updates) => {
      if (updates.deliveredDiffCommentSnapshots) {
        await release.promise
      }
    }
    const clearing = store.getState().clearDeliveredDiffComments(OWNER, [a])
    const editing = store.getState().updateDiffComment(OWNER, 'a', 'Edited sample note')
    release.resolve()
    expect(await clearing).toBe(false)
    expect(await editing).toBe(true)
    expect(shown(store)[0].body).toBe('Edited sample note')
    expect(shown(store)[0].sentAt).toBeUndefined()
  })

  it('still rolls back a queued note whose write fails after removal settles', async () => {
    const a = note('a')
    const store = createStore([a])
    const release = Promise.withResolvers<void>()
    host.gate = async (updates) => {
      if (updates.deliveredDiffCommentSnapshots) {
        await release.promise
        return
      }
      if (updates.diffComments?.some((n) => n.body === 'Unsaved sample note')) {
        throw new Error('Sample write refused before commit')
      }
    }
    const clearing = store.getState().clearDeliveredDiffComments(OWNER, [a])
    const adding = store.getState().addDiffComment(OWNER, {
      worktreeId: WT,
      filePath: 'sample.ts',
      lineNumber: 2,
      body: 'Unsaved sample note',
      side: 'modified'
    })
    expect(shown(store).map((n) => n.body)).toEqual([a.body, 'Unsaved sample note'])
    release.resolve()
    expect(await clearing).toBe(true)
    expect(await adding).toBeNull()
    // The refused note is not left on screen as if it were saved.
    expect(shown(store)).toEqual([])
    expect(host.notes).toEqual([])
  })

  it('keeps a later edit when an earlier queued write fails', async () => {
    const a = note('a')
    const store = createStore([a])
    const release = Promise.withResolvers<void>()
    let ordinaryWrites = 0
    host.gate = async (updates) => {
      if (updates.deliveredDiffCommentSnapshots) {
        await release.promise
        return
      }
      ordinaryWrites += 1
      if (ordinaryWrites === 1) {
        throw new Error('Sample write refused before commit')
      }
    }
    const clearing = store.getState().clearDeliveredDiffComments(OWNER, [a])
    const adding = store.getState().addDiffComment(OWNER, {
      worktreeId: WT,
      filePath: 'sample.ts',
      lineNumber: 2,
      body: 'Unsaved sample note',
      side: 'modified'
    })
    const added = shown(store).find((n) => n.body === 'Unsaved sample note')
    expect(added).toBeDefined()
    // A user edit after the queued write: rollback must not undo it.
    const editing = store.getState().updateDiffComment(OWNER, added!.id, 'Later sample edit')
    release.resolve()
    await clearing
    await adding
    await editing
    expect(shown(store).map((n) => n.body)).toEqual(['Later sample edit'])
    expect(host.notes.map((n) => n.body)).toEqual(['Later sample edit'])
  })

  it('keeps a note edited after the send captured it, and removes the rest', async () => {
    const [a, b] = [note('a'), note('b')]
    const store = createStore([a, b])
    expect(await store.getState().updateDiffComment(OWNER, 'a', 'Edited mid-send')).toBe(true)

    expect(await store.getState().clearDeliveredDiffComments(OWNER, [a, b])).toBe(true)

    expect(shown(store).map((n) => [n.id, n.body, n.sentAt])).toEqual([
      ['a', 'Edited mid-send', undefined]
    ])
    expect(host.notes.map((n) => n.body)).toEqual(['Edited mid-send'])
  })
})
