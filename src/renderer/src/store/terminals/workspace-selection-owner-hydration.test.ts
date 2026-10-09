import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../../shared/constants'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session-state-types'
import type { WorktreeSelectionOwner } from '../../../../shared/worktree-selection-owner'
import { createTestStore, makeWorktree, TEST_REPO } from '../slices/store-test-helpers'
import { createStoreSessionMockApi } from '../slices/store-session-test-harness'
import { makeFolderWorkspace } from '../slices/worktrees-slice-test-fixtures'
import { buildWorkspaceSessionPayload } from '../../lib/workspace-session'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
createStoreSessionMockApi()

const WORKTREE = 'repo1::/workspace/selected'
const OTHER_WORKTREE = 'repo1::/workspace/other'
const OWNER: WorktreeSelectionOwner = {
  worktreeId: WORKTREE,
  publisherHostId: 'runtime:hub-a',
  executionHostId: 'ssh:private-a',
  instanceId: 'selected-instance'
}

function savedSession(overrides: Partial<WorkspaceSessionState> = {}): WorkspaceSessionState {
  return {
    ...getDefaultWorkspaceSession(),
    activeRepoId: TEST_REPO.id,
    activeWorktreeId: WORKTREE,
    activeWorkspaceExecutionHostId: OWNER.publisherHostId,
    activeWorkspaceOwner: OWNER,
    tabsByWorktree: { [WORKTREE]: [] },
    ...overrides
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('selected workspace owner hydration', () => {
  it('retains exact ownership through a saved snapshot, hydration, and implicit reselect', () => {
    const worktree = makeWorktree({
      id: WORKTREE,
      repoId: TEST_REPO.id,
      hostId: OWNER.executionHostId,
      runtimeOwnerEnvironmentId: 'hub-a',
      instanceId: OWNER.instanceId
    })
    const source = createTestStore()
    source.setState({ repos: [TEST_REPO], worktreesByRepo: { [TEST_REPO.id]: [worktree] } })
    expect(source.getState().setActiveWorktree(WORKTREE, undefined, { owner: OWNER })).toBe(true)
    const payload = buildWorkspaceSessionPayload(source.getState())
    const restored = createTestStore()
    restored.setState({ repos: [TEST_REPO], worktreesByRepo: { [TEST_REPO.id]: [worktree] } })

    restored.getState().hydrateWorkspaceSession(payload)
    expect(restored.getState().setActiveWorktree(WORKTREE)).toBe(true)

    expect(restored.getState().activeWorkspaceOwner).toEqual(OWNER)
    expect(restored.getState().activeWorkspaceExecutionHostId).toBe(OWNER.executionHostId)
    expect(restored.getState().getKnownWorktreeById(WORKTREE)).toBe(worktree)
  })

  it.each([OWNER.publisherHostId, OWNER.executionHostId])(
    'keeps saved proof before the catalog loads with alias %s',
    (activeWorkspaceExecutionHostId) => {
      const store = createTestStore()
      store.setState({ repos: [TEST_REPO] })

      store.getState().hydrateWorkspaceSession(savedSession({ activeWorkspaceExecutionHostId }))

      expect(store.getState().activeWorktreeId).toBe(WORKTREE)
      expect(store.getState().activeWorkspaceOwner).toEqual(OWNER)
      expect(store.getState().worktreesByRepo[TEST_REPO.id] ?? []).toEqual([])
    }
  )

  it.each([
    { activeWorkspaceOwner: { ...OWNER, worktreeId: OTHER_WORKTREE } },
    { activeWorkspaceExecutionHostId: 'runtime:hub-b' as const },
    { activeWorkspaceExecutionHostId: null }
  ])('drops proof that disagrees with the surviving selection: %j', (override) => {
    const store = createTestStore()
    store.setState({ repos: [TEST_REPO] })

    store.getState().hydrateWorkspaceSession(savedSession(override))

    expect(store.getState().activeWorktreeId).toBe(WORKTREE)
    expect(store.getState().activeWorkspaceOwner).toBeNull()
  })

  it('clears existing proof when an older session has no selected owner', () => {
    const store = createTestStore()
    store.setState({ repos: [TEST_REPO], activeWorkspaceOwner: OWNER })
    const session = savedSession()
    delete session.activeWorkspaceOwner

    store.getState().hydrateWorkspaceSession(session)

    expect(store.getState().activeWorkspaceOwner).toBeNull()
  })

  it('preserves current proof outside a scoped hydration target', () => {
    const store = createTestStore()
    store.setState({
      repos: [TEST_REPO],
      activeWorktreeId: WORKTREE,
      activeWorkspaceExecutionHostId: OWNER.publisherHostId,
      activeWorkspaceOwner: OWNER,
      worktreesByRepo: {
        [TEST_REPO.id]: [
          makeWorktree({ id: WORKTREE, repoId: TEST_REPO.id }),
          makeWorktree({ id: OTHER_WORKTREE, repoId: TEST_REPO.id })
        ]
      }
    })

    store.getState().hydrateWorkspaceSession(
      savedSession({
        activeWorktreeId: OTHER_WORKTREE,
        activeWorkspaceOwner: null,
        tabsByWorktree: { [OTHER_WORKTREE]: [] }
      }),
      { replaceWorkspaceKeys: [OTHER_WORKTREE] }
    )

    expect(store.getState().activeWorktreeId).toBe(WORKTREE)
    expect(store.getState().activeWorkspaceOwner).toEqual(OWNER)
  })
})

describe('selected workspace owner lifecycle', () => {
  it('clears checkout proof when selecting a folder workspace', () => {
    const store = createTestStore()
    const folder = makeFolderWorkspace()
    store.setState({ folderWorkspaces: [folder], activeWorkspaceOwner: OWNER })

    store.getState().setActiveFolderWorkspace(folder.id, 'local')

    expect(store.getState().activeWorktreeId).toBe(`folder:${folder.id}`)
    expect(store.getState().activeWorkspaceOwner).toBeNull()
  })

  it('clears proof when the selected worktree is purged', () => {
    const store = createTestStore()
    store.setState({ activeWorktreeId: WORKTREE, activeWorkspaceOwner: OWNER })

    store.getState().purgeWorktreeTerminalState([WORKTREE])

    expect(store.getState().activeWorktreeId).toBeNull()
    expect(store.getState().activeWorkspaceOwner).toBeNull()
  })
})
