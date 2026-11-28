import { vi } from 'vitest'
import type { DiffComment } from '../../../../../shared/file-review/diff-comment-types'
import type { DiffCommentBaseMutation } from '../../../../../shared/file-review/diff-comment-mutation'
import { applyDiffCommentWrite } from '../../../../../shared/file-review/diff-comment-mutation'
import type { Repo } from '../../../../../shared/repository/repo-types'
import type { Worktree } from '../../../../../shared/worktree/types'
import '../../../../../shared/execution-host/execution-host'
import { createTestStore } from '../../testing/app-store-test-fixture'
import type { DiffCommentOwner } from './diff-comment-owner'

type Updates = { diffComments?: DiffComment[] } & DiffCommentBaseMutation

// A host on this computer: it keeps its own list and answers each write with it.
export const host: {
  notes: DiffComment[]
  // Older host: drops the cleanup field it does not know, as a stripping parser would.
  ignoresCleanup: boolean
  gate: ((updates: Updates) => Promise<void>) | null
} = { notes: [], ignoresCleanup: false, gate: null }
export const updateMeta = vi.fn(async ({ updates }: { updates: Updates }) => {
  await host.gate?.(updates)
  const applied = host.ignoresCleanup
    ? { ...updates, deliveredDiffCommentSnapshots: undefined }
    : updates
  host.notes = applyDiffCommentWrite(host.notes, applied) ?? host.notes
  return { diffComments: host.notes }
})
vi.stubGlobal('window', { api: { worktrees: { updateMeta }, ui: { set: vi.fn() } } })

const REPO = 'repo-1'
export const WT = `${REPO}::/work/sample`
export const OWNER: DiffCommentOwner = {
  kind: 'worktree',
  worktreeId: WT,
  authority: { endpoint: { kind: 'self' }, at: 'local' }
}

export function note(id: string, body = `Sample note ${id}`): DiffComment {
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

export function createStore(notes: DiffComment[]) {
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

export const shown = (store: ReturnType<typeof createStore>): DiffComment[] =>
  store.getState().getDiffComments(WT)

export const cleanupCalls = (): number =>
  updateMeta.mock.calls.filter(([args]) => args.updates.deliveredDiffCommentSnapshots).length
