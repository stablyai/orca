import { expect, it, vi } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session-state-types'
import { createTestStore } from './store-test-helpers'
import { createStoreSessionMockApi } from './store-session-test-harness'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
createStoreSessionMockApi()

it('restores a large editor session without rescanning earlier file owners', () => {
  const store = createTestStore()
  const count = 2_000
  let pathReads = 0
  const files = Array.from({ length: count }, (_, index) => ({
    get filePath() {
      pathReads++
      return `/project/file-${index}.ts`
    },
    relativePath: `file-${index}.ts`,
    worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
    language: 'typescript',
    runtimeEnvironmentId: index % 2 ? ' peer ' : null,
    dirtyDraftContent: `unsaved ${index}`
  }))
  const session: WorkspaceSessionState = {
    activeRepoId: null,
    activeWorktreeId: FLOATING_TERMINAL_WORKTREE_ID,
    activeTabId: null,
    tabsByWorktree: {},
    terminalLayoutsByTabId: {},
    openFilesByWorktree: { [FLOATING_TERMINAL_WORKTREE_ID]: files }
  }
  store.setState({ activeWorktreeId: FLOATING_TERMINAL_WORKTREE_ID })
  store.getState().hydrateEditorSession(session)
  const state = store.getState()
  expect(state.openFiles).toHaveLength(count)
  expect(pathReads).toBeLessThan(count * 20)
  for (let index = 0; index < count; index++) {
    const file = state.openFiles[index]
    expect(file.filePath).toBe(`/project/file-${index}.ts`)
    expect(state.editorDrafts[file.id]).toBe(`unsaved ${index}`)
  }
  expect(state.activeFileId).toBe(state.openFiles[0].id)
})
