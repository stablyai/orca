import { hasWorktreeParentLink } from '../../components/sidebar/worktree-context-menu-policy'
import { applyWorktreeLineageUpdate } from './worktrees/metadata/worktree-lineage-refresh'
import { getProjectedWorktreeLineage } from '../../components/sidebar/worktree-lineage-projection'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { worktreeWorkspaceKey } from '../../../../shared/workspace-scope'
import { makeLineage, makeWorkspaceLineage, makeWorktree } from './worktrees-slice-test-fixtures'
import {
  createTestStore,
  mockApi,
  resetRemoteRuntimeMocks,
  resetWorktreeSliceModuleMemory
} from './worktrees-slice-test-harness'

const requestWorktreeBaseFallbackNotice = vi.hoisted(() => vi.fn())

vi.mock('sonner', () => ({
  toast: {
    warning: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    dismiss: vi.fn()
  }
}))

vi.mock('@/components/worktree-base-fallback-notice', () => ({
  requestWorktreeBaseFallbackNotice
}))

beforeEach(resetWorktreeSliceModuleMemory)

describe('worktree lineage mutation ownership', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
  })
  it.each([true, false])(
    'preserves another host’s side maps while assigning=%s on a colliding locator',
    (assigning) => {
      const store = createTestStore()
      const foreignLineage = makeLineage({ worktreeInstanceId: 'foreign-instance' })
      const ownLineage = makeLineage({
        worktreeInstanceId: 'own-instance',
        parentWorktreeId: 'another-repo::/parent'
      })
      const own = makeWorktree({
        id: ownLineage.worktreeId,
        repoId: 'repo1',
        instanceId: 'own-instance',
        hostId: 'local'
      })
      const foreign = makeWorktree({
        id: foreignLineage.worktreeId,
        repoId: 'repo1',
        instanceId: 'foreign-instance',
        hostId: 'ssh:other'
      })
      const workspaceLineage = makeWorkspaceLineage({
        childWorkspaceKey: worktreeWorkspaceKey(foreign.id),
        childInstanceId: foreign.instanceId
      })
      store.setState({
        worktreesByRepo: { repo1: [own, foreign] },
        worktreeLineageById: { [foreign.id]: foreignLineage },
        workspaceLineageByChildKey: { [workspaceLineage.childWorkspaceKey]: workspaceLineage }
      })
      applyWorktreeLineageUpdate(
        store.setState,
        own.id,
        { target: { kind: 'local' }, lineage: assigning ? ownLineage : null },
        'local'
      )
      const state = store.getState()
      expect(state.worktreeLineageById[foreign.id]).toBe(foreignLineage)
      expect(state.workspaceLineageByChildKey[workspaceLineage.childWorkspaceKey]).toBe(
        workspaceLineage
      )
      expect(
        hasWorktreeParentLink(
          state.worktreesByRepo.repo1[0],
          state.worktreeLineageById,
          state.workspaceLineageByChildKey
        )
      ).toBe(assigning)
      expect(state.worktreesByRepo.repo1[1]).toBe(foreign)
      expect(
        getProjectedWorktreeLineage(state.worktreesByRepo.repo1[0], state.worktreeLineageById)
      ).toEqual(assigning ? ownLineage : null)
    }
  )

  it('keeps another host intact when unnest resolves the active colliding workspace', async () => {
    const store = createTestStore()
    const ownLineage = makeLineage({ worktreeInstanceId: 'own-instance' })
    const foreignLineage = makeLineage({ worktreeInstanceId: 'foreign-instance' })
    const own = {
      ...makeWorktree({
        id: ownLineage.worktreeId,
        repoId: 'repo1',
        hostId: 'local',
        instanceId: 'own-instance'
      }),
      lineage: ownLineage
    }
    const foreign = {
      ...own,
      hostId: 'ssh:other' as const,
      instanceId: 'foreign-instance',
      lineage: foreignLineage
    }
    const workspaceLineage = makeWorkspaceLineage({
      childWorkspaceKey: worktreeWorkspaceKey(own.id),
      childInstanceId: 'foreign-instance'
    })
    store.setState({
      activeWorktreeId: own.id,
      activeWorkspaceExecutionHostId: 'local',
      worktreesByRepo: { repo1: [own, foreign] },
      worktreeLineageById: { [own.id]: foreignLineage },
      workspaceLineageByChildKey: { [workspaceLineage.childWorkspaceKey]: workspaceLineage }
    })
    mockApi.worktrees.updateLineage.mockResolvedValue(null)
    await store.getState().updateWorktreeLineage(own.id, { noParent: true })
    const state = store.getState()
    expect(
      getProjectedWorktreeLineage(state.worktreesByRepo.repo1[0], state.worktreeLineageById)
    ).toBeNull()
    expect(state.worktreesByRepo.repo1[1]).toBe(foreign)
    expect(state.worktreeLineageById[own.id]).toBe(foreignLineage)
    expect(state.workspaceLineageByChildKey[workspaceLineage.childWorkspaceKey]).toBe(
      workspaceLineage
    )
  })

  it('does not project a direct SSH mutation into a relayed copy of the same host', () => {
    const store = createTestStore()
    const own = makeWorktree({
      id: 'repo1::/path/child',
      repoId: 'repo1',
      hostId: 'ssh:other',
      instanceId: 'direct-instance'
    })
    const relayed = { ...own, runtimeOwnerEnvironmentId: 'hub', instanceId: 'relay-instance' }
    store.setState({ worktreesByRepo: { repo1: [own, relayed] } })
    applyWorktreeLineageUpdate(
      store.setState,
      own.id,
      { target: { kind: 'local' }, lineage: makeLineage({ worktreeId: own.id }) },
      'ssh:other'
    )
    expect(store.getState().worktreesByRepo.repo1[1]).toBe(relayed)
  })
})
