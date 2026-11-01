import { expect, it, vi } from 'vitest'
import { terminalHostAliasSchema } from '../../../../shared/terminal-host-alias'
import {
  createTestStore,
  makeTab,
  makeUnifiedTab,
  makeTabGroup,
  seedStore
} from '../slices/store-test-helpers'
import { createStoreCascadesMockApi } from '../slices/store-cascades-test-harness'
import { layoutApplyTestTransport } from '@/runtime/layout-apply-test-transport.test-fixture'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'

const closeHostTab = vi.hoisted(() => vi.fn())
vi.mock('@/runtime/web-runtime-session-tab-lifecycle', () => ({
  closeWebRuntimeSessionTab: closeHostTab
}))
vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)

it('retains aliases on exit or failed HOST close and retires LOCAL membership after HOST ack', async () => {
  const api = createStoreCascadesMockApi()
  const closeTerminalSurface = vi.fn().mockResolvedValue(undefined)
  Object.assign(api, { session: { closeTerminalSurface } })
  layoutApplyTestTransport.reset()
  const alias = terminalHostAliasSchema.parse({
    executionHostId: 'runtime:host',
    worktreeId: 'host::/project',
    tabId: 'host-tab',
    leafId: '00000000-0000-4000-8000-000000000001'
  })
  const id = 'web-terminal-host-tab'
  const local = 'repo::/local'
  const store = createTestStore()
  seedStore(store, {
    tabsByWorktree: {
      [local]: [makeTab({ id, worktreeId: local, ptyId: null, hostTerminalAlias: alias })],
      [alias.worktreeId]: [makeTab({ id, worktreeId: alias.worktreeId, ptyId: null })]
    },
    unifiedTabsByWorktree: {
      [local]: [
        makeUnifiedTab({
          id,
          entityId: id,
          worktreeId: local,
          groupId: 'group',
          hostTerminalAlias: alias,
          executionHostId: alias.executionHostId
        })
      ]
    },
    groupsByWorktree: {
      [local]: [makeTabGroup({ id: 'group', worktreeId: local, tabOrder: [id], activeTabId: id })]
    }
  })
  store.getState().closeTab(id, { reason: 'pty-exit' })
  store.getState().closeTab(id, { reason: 'cleanup', remoteCloseOwnedByHost: true })
  expect(closeHostTab).not.toHaveBeenCalled()
  closeHostTab.mockResolvedValueOnce('failed')
  store.getState().closeTab(id)
  await vi.waitFor(() => expect(closeHostTab).toHaveBeenCalledTimes(1))
  expect(store.getState().tabsByWorktree[local]).toHaveLength(1)
  closeHostTab.mockResolvedValueOnce('applied')
  store.getState().closeTab(id, { force: true })
  await vi.waitFor(() => expect(store.getState().tabsByWorktree[local]).toEqual([]))
  expect(store.getState().unifiedTabsByWorktree[local]).toEqual([])
  expect(closeHostTab).toHaveBeenLastCalledWith({
    worktreeId: alias.worktreeId,
    tabId: alias.tabId,
    environmentId: 'host',
    reason: 'user',
    force: true
  })
  expect(api.pty.kill).not.toHaveBeenCalled()
  if (ORCA_LAYOUT_OWNER_IS_MAIN) {
    expect(layoutApplyTestTransport.sentOfType('closeTabs')).toEqual([
      expect.objectContaining({ workspace: local, tabIds: [id] })
    ])
  } else {
    expect(closeTerminalSurface).toHaveBeenCalledWith({
      worktreeId: local,
      target: { kind: 'tab', tabId: id },
      reason: 'user'
    })
  }
  store.setState({
    tabsByWorktree: {
      [local]: [
        makeTab({
          id,
          worktreeId: local,
          ptyId: null,
          hostTerminalAlias: alias,
          hostTerminalAliasGone: true
        })
      ]
    }
  })
  store.getState().closeTab(id)
  await vi.waitFor(() => expect(store.getState().tabsByWorktree[local]).toEqual([]))
  expect(closeHostTab).toHaveBeenCalledTimes(2)
})
