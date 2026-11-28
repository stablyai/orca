import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DiffComment } from '../../../../../shared/file-review/diff-comment-types'
import type { DiffCommentBaseMutation } from '../../../../../shared/file-review/diff-comment-mutation'
import { applyDiffCommentWrite } from '../../../../../shared/file-review/diff-comment-mutation'
import type { Repo } from '../../../../../shared/repository/repo-types'
import type { Worktree } from '../../../../../shared/worktree/types'
import '../../../../../shared/execution-host/execution-host'
import {
  diffCommentSendKey,
  isNoteInFlight
} from '@/components/notes/delivery/notes-send-in-flight'
import { createTestStore } from '../../testing/app-store-test-fixture'
import type { DiffCommentOwner } from './diff-comment-owner'

type ToastOptions = { action?: { label: string; onClick: () => void } }
const toastError = vi.hoisted(() => vi.fn<(message: string, options?: ToastOptions) => void>())
const toastDismiss = vi.hoisted(() => vi.fn())
vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: toastError, dismiss: toastDismiss }
}))

type Updates = { diffComments?: DiffComment[] } & DiffCommentBaseMutation

// A host on this computer: it keeps its own list and answers each write with it.
const host: {
  notes: DiffComment[]
  // Older host: drops the cleanup field it does not know, as a stripping parser would.
  ignoresCleanup: boolean
  gate: ((updates: Updates) => Promise<void>) | null
} = { notes: [], ignoresCleanup: false, gate: null }
const updateMeta = vi.fn(async ({ updates }: { updates: Updates }) => {
  await host.gate?.(updates)
  const applied = host.ignoresCleanup
    ? { ...updates, deliveredDiffCommentSnapshots: undefined }
    : updates
  host.notes = applyDiffCommentWrite(host.notes, applied) ?? host.notes
  return { diffComments: host.notes }
})
vi.stubGlobal('window', { api: { worktrees: { updateMeta }, ui: { set: vi.fn() } } })

const REPO = 'repo-1'
const WT = `${REPO}::/work/sample`
const OWNER: DiffCommentOwner = {
  kind: 'worktree',
  worktreeId: WT,
  authority: { endpoint: { kind: 'self' }, at: 'local' }
}

function note(id: string, body = `Sample note ${id}`): DiffComment {
  return {
    id,
    worktreeId: WT,
    filePath: 'sample.ts',
    lineNumber: 1,
    body,
    createdAt: 1,
    side: 'modified'
  }
}

function worktree(diffComments: DiffComment[]): Worktree {
  return {
    id: WT,
    repoId: REPO,
    path: '/work/sample',
    head: 'abc',
    branch: 'refs/heads/sample',
    isBare: false,
    isMainWorktree: false,
    displayName: 'sample',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    hostId: 'local',
    diffComments
  }
}

function createStore(notes: DiffComment[]) {
  host.notes = notes
  const repo: Repo = {
    id: REPO,
    path: '/work/repo',
    displayName: 'repo',
    badgeColor: '#000',
    addedAt: 0,
    executionHostId: 'local'
  }
  const store = createTestStore()
  store.setState({ repos: [repo], worktreesByRepo: { [REPO]: [worktree(notes)] } })
  return store
}

const shown = (store: ReturnType<typeof createStore>): DiffComment[] =>
  store.getState().getDiffComments(WT)

const cleanupCalls = (): number =>
  updateMeta.mock.calls.filter(([args]) => args.updates.deliveredDiffCommentSnapshots).length

describe('removing delivered review notes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    host.ignoresCleanup = false
    host.gate = null
  })

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
    expect(toastError).toHaveBeenCalledTimes(1)
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
})
