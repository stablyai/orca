import { expect, it, vi } from 'vitest'
import { withFrameDrawnChatTabPlacement } from './frame-drawn-chat-tab-placement'

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      groupsByWorktree: { 'wt-1': [{ id: 'group-1', tabOrder: ['tab-source', 'tab-b'] }] }
    })
  }
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({
  readCachedRuntimeEnvironmentCapability: () => true
}))
vi.mock('@/runtime/server-layout-apply-routes', () => ({
  serverLayoutApplyRoute: () => ({
    serverTabId: (id: string) => (id === 'tab-source' ? 'server-source' : null)
  })
}))
vi.mock('@/runtime/web-session-tabs-sync/frame-drawn-server-workspaces', () => ({
  isFrameDrawnServerWorkspace: () => true
}))
vi.mock('./desktop-created-server-tabs', () => ({ noteDesktopCreatedServerTab: vi.fn() }))

it('places a paired fork with no tab of its own right after its source, from the address taken at the click', () => {
  const params = withFrameDrawnChatTabPlacement({
    target: { kind: 'environment', environmentId: 'env-1' },
    worktreeId: 'wt-1',
    sessionId: 'codex_child',
    params: {
      envelope: {
        sessionId: 'codex_child',
        clientOperationId: 'op',
        expectedRuntimeFence: null,
        payloadFingerprint: 'f'
      },
      worktree: 'id:wt-1',
      agent: 'codex',
      forkFrom: { sessionId: 'codex_source', throughItemId: 'item-reply' }
    },
    // Captured from [source, B]: the child goes after the source, ahead of B.
    surfaceAddress: {
      worktreeId: 'wt-1',
      targetGroupId: 'group-1',
      precedingTabIds: ['tab-source']
    }
  })
  expect(params.tabPlacement).toEqual({ groupId: 'group-1', afterTabId: 'server-source' })
})
