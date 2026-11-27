import type * as RuntimeRpcCallModule from '../../../runtime/rpc/calls/runtime-rpc-call'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DiffComment } from '../../../../../shared/file-review/diff-comment-types'
import type { Repo } from '../../../../../shared/repository/repo-types'
import type { Worktree } from '../../../../../shared/worktree/types'
import type { CombinedDiffAlternate } from '../../../../../shared/editor/views/editor-tab-view-types'
import type { GitStatusEntry } from '../../../../../shared/git/status/git-status-types'
import '../../../../../shared/execution-host/execution-host'
import { createTestStore } from '../../testing/app-store-test-fixture'

vi.mock('../../../runtime/rpc/calls/runtime-rpc-call', async (importOriginal) => ({
  ...(await importOriginal<typeof RuntimeRpcCallModule>()),
  callRuntimeRpc: vi.fn().mockResolvedValue({ ok: true })
}))
vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.stubGlobal('window', { api: { worktrees: { updateMeta: vi.fn() }, ui: { set: vi.fn() } } })

const REPO = 'repo-1'
const WT = `${REPO}::/work/feature`

function note(id: string): DiffComment {
  return {
    id,
    worktreeId: WT,
    filePath: 'a.ts',
    lineNumber: 1,
    body: id,
    createdAt: 1,
    side: 'modified'
  }
}

function worktree(hostId: Worktree['hostId'], diffComments: DiffComment[]): Worktree {
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

const repoBase = {
  id: REPO,
  path: '/work/repo',
  displayName: 'repo',
  badgeColor: '#000',
  addedAt: 0
}

// The same worktree id on this computer and on an SSH host, each with a note.
function createStore(activeHostId: 'local' | 'ssh:box') {
  const repos: Repo[] = [
    { ...repoBase, executionHostId: 'local' },
    { ...repoBase, connectionId: 'box', executionHostId: 'ssh:box' }
  ]
  const store = createTestStore()
  store.setState({
    activeWorktreeId: WT,
    activeWorkspaceExecutionHostId: activeHostId,
    repos,
    worktreesByRepo: {
      [REPO]: [worktree('local', [note('l1')]), worktree('ssh:box', [note('s1')])]
    }
  })
  return store
}

function changesFiles(store: ReturnType<typeof createStore>) {
  return store.getState().openFiles.filter((file) => file.id.includes('::all-diffs::uncommitted'))
}

describe('Send review notes shortcut', () => {
  beforeEach(() => vi.clearAllMocks())

  it('opens the Changes tab and asks its Send menu to open', () => {
    const store = createStore('local')

    expect(store.getState().openDiffNotesSendMenuForActiveWorktree()).toBe(true)

    const [changes] = changesFiles(store)
    expect(changes).toBeDefined()
    expect(store.getState().activeFileId).toBe(changes.id)
    expect(store.getState().diffNotesSendMenuOpenRequest?.worktreeId).toBe(WT)
  })

  it('reuses an open Changes tab without replacing its comparison or snapshot', () => {
    const store = createStore('local')
    store.getState().openDiffNotesSendMenuForActiveWorktree()
    const [opened] = changesFiles(store)
    const alternate: CombinedDiffAlternate = { source: 'combined-branch' }
    const snapshot: GitStatusEntry[] = []
    store.setState((s) => ({
      openFiles: s.openFiles.map((file) =>
        file.id === opened.id
          ? {
              ...file,
              combinedAlternate: alternate,
              uncommittedEntriesSnapshot: snapshot
            }
          : file
      ),
      activeFileId: null
    }))

    store.getState().openDiffNotesSendMenuForActiveWorktree()

    const after = changesFiles(store)
    expect(after).toHaveLength(1)
    expect(after[0].combinedAlternate).toBe(alternate)
    expect(after[0].uncommittedEntriesSnapshot).toBe(snapshot)
    expect(store.getState().activeFileId).toBe(opened.id)
  })

  it("opens the selected host's own Changes tab when its twin already has one", () => {
    const store = createStore('local')
    store.getState().openDiffNotesSendMenuForActiveWorktree()
    const [local] = changesFiles(store)

    store.setState({ activeWorkspaceExecutionHostId: 'ssh:box' })
    store.getState().openDiffNotesSendMenuForActiveWorktree()

    const files = changesFiles(store)
    expect(files).toHaveLength(2)
    const remote = files.find((file) => file.id !== local.id)
    expect(store.getState().activeFileId).toBe(remote?.id)
  })
})
