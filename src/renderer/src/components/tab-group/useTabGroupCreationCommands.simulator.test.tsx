import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'
import type { TabGroupWorktreeSnapshot } from './useTabGroupItemProjections'
import { createTestStore, seedStore } from '@/store/testing/app-store-test-fixture'
import { createStoreCascadesMockApi } from '@/store/testing/app-store-cascade-api.test-fixture'
import { setLocalRuntimeCapabilitiesForTests } from '@/runtime/hosts/capabilities/local-runtime-capabilities'
import { EMULATOR_OPENING_PREFERENCES_CAPABILITY } from '../../../../shared/emulator-runtime-capabilities'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { useTabGroupCreationCommands } from './useTabGroupCreationCommands'
import { toast } from 'sonner'

const selected = vi.hoisted((): { store: ReturnType<typeof createTestStore> | null } => ({
  store: null
}))
vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (state: AppState) => unknown) => selector(selected.store!.getState()),
    { getState: () => selected.store!.getState() }
  )
}))
vi.mock('../../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: false }))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({
  callRuntimeRpc: vi.fn(async () => ({ attached: false })),
  runtimeEnvironmentSupportsCapability: async () => false
}))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), info: vi.fn(), warning: vi.fn() } }))
const domWindow = window
const id = 'repo1::/shared'
const snapshot: TabGroupWorktreeSnapshot = {
  groups: [],
  unifiedTabs: [],
  terminalTabs: [],
  openFiles: [],
  browserTabs: [],
  expandedPaneByTabId: {},
  terminalLayoutsByTabId: {},
  generatedTabTitlesEnabled: false,
  mobileEmulatorEnabled: true
}
beforeEach(() => {
  const api = createStoreCascadesMockApi()
  globalThis.window = Object.assign(domWindow, { api })
  selected.store = createTestStore()
  seedStore(selected.store, {
    activeWorktreeId: id,
    activeWorkspaceExecutionHostId: 'runtime:peer',
    worktreesByRepo: {
      repo1: [
        makeWorktree({ id, repoId: 'repo1', hostId: 'local' }),
        makeWorktree({
          id,
          repoId: 'repo1',
          hostId: 'runtime:peer',
          runtimeOwnerEnvironmentId: 'peer'
        })
      ]
    }
  })
  setLocalRuntimeCapabilitiesForTests([EMULATOR_OPENING_PREFERENCES_CAPABILITY])
  selected.store.getState().createUnifiedTab(id, 'simulator', {
    id: 'local-sim',
    executionHostId: 'local',
    targetGroupId: 'local-group'
  })
  vi.mocked(callRuntimeRpc).mockClear()
})
afterEach(() => {
  cleanup()
  setLocalRuntimeCapabilitiesForTests(null)
})
it('refuses simulator creation on an ambiguous captured host', async () => {
  const hook = renderHook(() =>
    useTabGroupCreationCommands({
      worktreeId: id,
      groupId: 'remote-group',
      executionHostId: 'ssh:box',
      worktreeState: snapshot
    })
  )
  selected.store!.setState({
    worktreesByRepo: {
      repo1: [
        makeWorktree({ id, repoId: 'repo1', hostId: 'ssh:box', runtimeOwnerEnvironmentId: 'peer' }),
        makeWorktree({ id, repoId: 'repo1', hostId: 'ssh:box', runtimeOwnerEnvironmentId: 'rival' })
      ]
    }
  })
  vi.mocked(toast.error).mockClear()
  await act(async () => {
    await hook.result.current.newSimulatorTab?.()
  })
  expect(selected.store!.getState().unifiedTabsByWorktree[id].map((tab) => tab.id)).toEqual([
    'local-sim'
  ])
  expect(toast.error).toHaveBeenCalledWith('The selected workspace host is unavailable.')
})
it.each([true, false])(
  'uses the selected runtime copy while a local twin has a simulator (existing=%s)',
  async (existing) => {
    if (existing) {
      selected.store!.getState().createUnifiedTab(id, 'simulator', {
        id: 'remote-sim',
        executionHostId: 'runtime:peer',
        targetGroupId: 'remote-group'
      })
    }
    const hook = renderHook(() =>
      useTabGroupCreationCommands({
        worktreeId: id,
        groupId: 'remote-group',
        executionHostId: 'runtime:peer',
        worktreeState: snapshot
      })
    )
    await act(async () => {
      await hook.result.current.newSimulatorTab?.()
    })
    const state = selected.store!.getState()
    const group = state.groupsByWorktree[id]?.find(
      (group) => group.id === state.activeGroupIdByWorktree[id]
    )
    const tab = state.unifiedTabsByWorktree[id].find((tab) => tab.id === group?.activeTabId)
    expect(tab).toMatchObject({ contentType: 'simulator', executionHostId: 'runtime:peer' })
    if (existing) {
      expect(tab?.id).toBe('remote-sim')
    } else {
      expect(tab?.id).not.toBe('local-sim')
    }
  }
)
it('keeps the emulator provider local when creating the selected runtime copy tab', async () => {
  setLocalRuntimeCapabilitiesForTests([])
  const hook = renderHook(() =>
    useTabGroupCreationCommands({
      worktreeId: id,
      groupId: 'remote-group',
      executionHostId: 'runtime:peer',
      worktreeState: snapshot
    })
  )
  await act(async () => {
    await hook.result.current.newSimulatorTab?.()
  })
  expect(callRuntimeRpc).toHaveBeenCalledWith({ kind: 'local' }, 'emulator.attach', {
    worktree: id,
    focus: false
  })
})
