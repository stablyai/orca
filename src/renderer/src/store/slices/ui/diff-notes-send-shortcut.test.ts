import type * as RuntimeRpcCallModule from '../../../runtime/rpc/calls/runtime-rpc-call'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DiffComment } from '../../../../../shared/file-review/diff-comment-types'
import type { Repo } from '../../../../../shared/repository/repo-types'
import type { Worktree } from '../../../../../shared/worktree/types'
import type { CombinedDiffAlternate } from '../../../../../shared/editor/views/editor-tab-view-types'
import type { GitStatusEntry } from '../../../../../shared/git/status/git-status-types'
import '../../../../../shared/execution-host/execution-host'
import { createTestStore } from '../../testing/app-store-test-fixture'
import { drawTabsFromMain, type TabsDrawnFromMain } from '../tabs/tabs-drawn-from-main.test-fixture'

// Switch on, main's stand-in answers layout.apply; other calls resolve ok.
vi.mock('../../../runtime/rpc/calls/runtime-rpc-call', async (importOriginal) =>
  (
    await import('@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply({
    ...(await importOriginal<typeof RuntimeRpcCallModule>()),
    callRuntimeRpc: vi.fn().mockResolvedValue({ ok: true })
  })
)
vi.mock('@/runtime/workspace-layout/frames/runtime-layout-client', async (importOriginal) =>
  (
    await import('@/runtime/workspace-layout/testing/layout-apply-test-transport.test-fixture')
  ).runtimeLayoutClientWithTestFrames(await importOriginal())
)
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

let main: TabsDrawnFromMain | undefined

// The same worktree id on this computer and on an SSH host, each with a note.
async function createStore(activeHostId: 'local' | 'ssh:box') {
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
  main = await drawTabsFromMain(store)
  return store
}

type Store = Awaited<ReturnType<typeof createStore>>

/** Presses the shortcut, then waits for main's answer and the frame that draws the tab. */
async function press(store: Store): Promise<boolean> {
  const handled = store.getState().openDiffNotesSendMenuForActiveWorktree()
  await main?.settle()
  return handled
}

function changesFiles(store: Store) {
  return store.getState().openFiles.filter((file) => file.id.includes('::all-diffs::uncommitted'))
}

describe('Send review notes shortcut', () => {
  beforeEach(() => vi.clearAllMocks())
  afterEach(() => main?.close())

  it('opens the Changes tab and asks its Send menu to open', async () => {
    const store = await createStore('local')

    expect(await press(store)).toBe(true)

    const [changes] = changesFiles(store)
    expect(changes).toBeDefined()
    expect(store.getState().activeFileId).toBe(changes.id)
    expect(store.getState().diffNotesSendMenuOpenRequest?.worktreeId).toBe(WT)
  })

  it('reuses an open Changes tab without replacing its comparison or snapshot', async () => {
    const store = await createStore('local')
    await press(store)
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

    await press(store)

    const after = changesFiles(store)
    expect(after).toHaveLength(1)
    expect(after[0].combinedAlternate).toBe(alternate)
    expect(after[0].uncommittedEntriesSnapshot).toBe(snapshot)
    expect(store.getState().activeFileId).toBe(opened.id)
  })

  it("opens the selected host's own Changes tab when its twin already has one", async () => {
    const store = await createStore('local')
    await press(store)
    const [local] = changesFiles(store)

    store.setState({ activeWorkspaceExecutionHostId: 'ssh:box' })
    await press(store)

    const files = changesFiles(store)
    expect(files).toHaveLength(2)
    const remote = files.find((file) => file.id !== local.id)
    expect(store.getState().activeFileId).toBe(remote?.id)
  })
})
