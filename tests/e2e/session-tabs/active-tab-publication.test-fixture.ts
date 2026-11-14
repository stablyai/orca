import { vi } from 'vitest'
import {
  listWorktrees,
  listWorktreesSharedStrict
} from '../../../src/main/git/worktrees/catalog/worktree-scan-cache'
import { listWorktreesStrict } from '../../../src/main/git/worktrees/catalog/worktree-listing'
import {
  MOCK_GIT_WORKTREES,
  scanLocalRepoWorktreesForResolutionMock
} from '../../../src/main/runtime/orca-runtime-test-mocks/setup.spec'
import '../../../src/main/runtime/orca-runtime-tests/runtime-test-module-registration.spec'
import { OrcaRuntimeService } from '../../../src/main/runtime/orca-runtime'
import {
  HEADLESS_LEAF_ID,
  TEST_WORKTREE_ID as WT,
  TEST_WORKTREE_PATH,
  makeHeadlessTerminalLayout,
  makeRuntimeStoreWithWorkspaceSession,
  makeWorkspaceSessionWithHeadlessTerminal
} from '../../../src/main/runtime/orca-runtime-tests/orca-runtime-test-fixtures.spec'

export function createRuntimeFixture(attached = true) {
  vi.mocked(listWorktrees).mockResolvedValue(MOCK_GIT_WORKTREES)
  vi.mocked(listWorktreesStrict).mockResolvedValue(MOCK_GIT_WORKTREES)
  vi.mocked(listWorktreesSharedStrict).mockResolvedValue(MOCK_GIT_WORKTREES)
  scanLocalRepoWorktreesForResolutionMock.mockResolvedValue({
    ok: true,
    worktrees: MOCK_GIT_WORKTREES
  })
  const session = makeWorkspaceSessionWithHeadlessTerminal({
    tabGroupLayouts: {
      [WT]: {
        type: 'split',
        direction: 'vertical',
        first: { type: 'leaf', groupId: 'g' },
        second: { type: 'leaf', groupId: 'g2' }
      }
    },
    activeTabId: 'serve-tab',
    activeTabIdByWorktree: { [WT]: 'serve-tab' },
    tabsByWorktree: {
      [WT]: [
        {
          id: 'serve-tab',
          ptyId: 'serve-active',
          worktreeId: WT,
          title: 'Terminal',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    },
    terminalLayoutsByTabId: {
      'serve-tab': makeHeadlessTerminalLayout({ [HEADLESS_LEAF_ID]: 'serve-active' })
    }
  })
  const { runtimeStore, getSession, setSession } = makeRuntimeStoreWithWorkspaceSession(session)
  const runtime = new OrcaRuntimeService(runtimeStore)
  runtime.setPtyController({
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null,
    listProcesses: async () => [{ id: 'serve-active', cwd: TEST_WORKTREE_PATH, title: 'sh' }]
  })
  if (attached) {
    runtime.attachWindow(1)
  }
  return { runtime, runtimeStore, getSession, setSession }
}
