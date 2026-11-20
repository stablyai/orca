import type * as RuntimeRpcCallModule from '../../../runtime/rpc/calls/runtime-rpc-call'

import { callRuntimeRpc } from '../../../runtime/rpc/calls/runtime-rpc-call'
import { resetNotesInFlightForTests } from '@/components/notes/delivery/notes-send-in-flight'
import type { AppState } from '../../types'
import { selectDiffCommentView, type DiffCommentOwner } from './diff-comment-owner'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import type { DiffComment } from '../../../../../shared/file-review/diff-comment-types'
import type { Repo } from '../../../../../shared/repository/repo-types'
import type { Worktree } from '../../../../../shared/worktree/types'
import '../../../../../shared/execution-host/execution-host'
import { createTestStore } from '../../testing/app-store-test-fixture'

vi.mock('../../../runtime/rpc/calls/runtime-rpc-call', async (importOriginal) => ({
  ...(await importOriginal<typeof RuntimeRpcCallModule>()),
  callRuntimeRpc: vi.fn().mockResolvedValue({ ok: true })
}))

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))

const updateMeta = vi.fn()

vi.stubGlobal('window', {
  api: { worktrees: { updateMeta }, ui: { set: vi.fn() } }
})

const REPO = 'repo-1'
const WT = `${REPO}::/work/feature`

function worktree(hostId: Worktree['hostId'], diffComments: DiffComment[] = []): Worktree {
  return {
    id: WT,
    repoId: REPO,
    path: '/work/feature',
    head: 'abc',
    branch: 'refs/heads/feature',
    isBare: false,
    isMainWorktree: false,
    displayName: 'feature',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    hostId,
    diffComments
  }
}

function note(id: string, body: string): DiffComment {
  return { id, worktreeId: WT, filePath: 'a', lineNumber: 1, body, createdAt: 1, side: 'modified' }
}

const repoBase = {
  id: REPO,
  path: '/work/repo',
  displayName: 'repo',
  badgeColor: '#000',
  addedAt: 0
}

// Same project and worktree id on this computer and on an SSH host.
function createTwinStore(activeHostId: Worktree['hostId'] | null) {
  const repos: Repo[] = [
    { ...repoBase, executionHostId: 'local' },
    { ...repoBase, connectionId: 'box', executionHostId: 'ssh:box' }
  ]
  const store = createTestStore()
  store.setState({
    activeWorktreeId: activeHostId ? WT : null,
    activeWorkspaceExecutionHostId: activeHostId,
    repos,
    worktreesByRepo: { [REPO]: [worktree('local'), worktree('ssh:box')] }
  })
  return store
}

function rowNotes(store: ReturnType<typeof createTwinStore>, hostId: string): string[] {
  const row = store.getState().worktreesByRepo[REPO].find((w) => w.hostId === hostId)
  return (row?.diffComments ?? []).map((comment) => comment.body)
}

beforeEach(() => {
  vi.mocked(callRuntimeRpc).mockClear()
  vi.mocked(toast.error).mockClear()
  resetNotesInFlightForTests()
  updateMeta.mockReset()
  updateMeta.mockResolvedValue({})
})

function capturedOwner(store: { getState: () => AppState }, worktreeId: string): DiffCommentOwner {
  const { owner } = selectDiffCommentView(store.getState(), worktreeId, 'selection')
  if (!owner) {
    throw new Error('No copy of the workspace is shown.')
  }
  return owner
}

describe('captured note owners across delivery and selection', () => {
  it('refuses every mutation when the captured twin was removed', async () => {
    const store = createTwinStore('ssh:box')
    const sent = note('same-id', 'same body')
    store.setState({
      worktreesByRepo: { [REPO]: [worktree('local', [sent]), worktree('ssh:box', [sent])] }
    })
    const owner = capturedOwner(store, WT)
    store.setState({
      activeWorkspaceExecutionHostId: 'local',
      worktreesByRepo: { [REPO]: [worktree('local', [sent])] }
    })
    expect(await store.getState().clearDeliveredDiffComments(owner, [sent])).toBe(false)
    expect(await store.getState().clearDiffComments(owner)).toBe(false)
    expect(await store.getState().clearDiffCommentsForFile(owner, 'a')).toBe(false)
    expect(await store.getState().markDiffCommentsSent(owner, [sent.id])).toBe(false)
    expect(await store.getState().updateDiffComment(owner, sent.id, 'changed')).toBe(false)
    await store.getState().deleteDiffComment(owner, sent.id)
    expect(rowNotes(store, 'local')).toEqual(['same body'])
    expect(updateMeta).not.toHaveBeenCalled()
  })
})

describe('snapshot-matched Markdown review note bulk clear', () => {
  it('preserves edited notes, newly added notes, and other document/diff notes', async () => {
    const original = {
      ...note('one', 'original'),
      source: 'markdown' as const,
      filePath: 'notes.md'
    }
    const revised = { ...original, body: 'edited after confirmation' }
    const unchanged = {
      ...note('unchanged', 'already handled'),
      source: 'markdown' as const,
      filePath: 'notes.md'
    }
    const newer = {
      ...note('new', 'added after confirmation'),
      source: 'markdown' as const,
      filePath: 'notes.md'
    }
    const unrelated = {
      ...note('other-file', 'other document'),
      source: 'markdown' as const,
      filePath: 'other.md'
    }
    const diffNote = {
      ...note('diff', 'normal diff note'),
      source: 'diff' as const,
      filePath: 'notes.md'
    }
    const store = createTwinStore('local')
    store.setState({
      worktreesByRepo: {
        [REPO]: [
          worktree('local', [original, unchanged, unrelated, diffNote]),
          worktree('ssh:box', [original])
        ]
      }
    })
    const owner = capturedOwner(store, WT)
    // Simulate editing one note and adding another while the confirmation is open.
    store.setState({
      worktreesByRepo: {
        [REPO]: [
          worktree('local', [revised, unchanged, newer, unrelated, diffNote]),
          worktree('ssh:box', [original])
        ]
      }
    })
    expect(await store.getState().clearDeliveredDiffComments(owner, [original, unchanged])).toBe(
      true
    )
    expect(rowNotes(store, 'local')).toEqual([
      'edited after confirmation',
      'added after confirmation',
      'other document',
      'normal diff note'
    ])
    expect(rowNotes(store, 'ssh:box')).toEqual(['original'])
  })

  it('allows a confirmation dialog to own lost-owner error feedback without double toast', async () => {
    const store = createTwinStore('ssh:box')
    const sent = { ...note('same-id', 'same body'), source: 'markdown' as const }
    store.setState({
      worktreesByRepo: { [REPO]: [worktree('local', [sent]), worktree('ssh:box', [sent])] }
    })
    const owner = capturedOwner(store, WT)
    store.setState({
      activeWorkspaceExecutionHostId: 'local',
      worktreesByRepo: { [REPO]: [worktree('local', [sent])] }
    })

    expect(
      await store.getState().clearDeliveredDiffComments(owner, [sent], {
        suppressLostOwnerToast: true
      })
    ).toBe(false)
    expect(toast.error).not.toHaveBeenCalled()
    // Existing send-to-agent callers retain their default notification.
    expect(await store.getState().clearDeliveredDiffComments(owner, [sent])).toBe(false)
    expect(toast.error).toHaveBeenCalledTimes(1)
    expect(rowNotes(store, 'local')).toEqual(['same body'])
  })
})
