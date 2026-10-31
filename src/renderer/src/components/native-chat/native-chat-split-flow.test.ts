// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { createTestStore } from '@/store/slices/store-test-helpers'
import { createTabsSliceMockApi } from '@/store/slices/tabs-slice-test-harness'

let store: ReturnType<typeof createTestStore>
const launch = vi.hoisted(() => vi.fn())
vi.mock('@/store', () => ({ useAppStore: { getState: () => store.getState() } }))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('@/lib/launch-agent-in-new-tab', () => ({ launchAgentInNewTab: launch }))
createTabsSliceMockApi()

import { runNativeChatSplitTarget } from './native-chat-layout-actions'

it.each(['right', 'down'] as const)(
  'Split %s opens a fresh chat beside the current one',
  (direction) => {
    launch.mockReset()
    store = createTestStore()
    const worktreeId = 'folder-workspace'
    const executionHostId = 'runtime:remote-host'
    const source = store.getState().createUnifiedTab(worktreeId, 'agent-session', {
      agentSessionAgent: 'codex',
      executionHostId
    })
    const { id: unifiedTabId, groupId: sourceGroupId } = source
    const target = { kind: 'workspace-tab', unifiedTabId, groupId: sourceGroupId } as const
    launch.mockReturnValue({ surface: { kind: 'local-chat', tabId: 'fresh' } })
    expect(runNativeChatSplitTarget(target, direction)).toBe(true)
    const groupId = store.getState().activeGroupIdByWorktree[worktreeId]
    expect(store.getState().layoutByWorktree[worktreeId]).toMatchObject({
      direction: direction === 'right' ? 'horizontal' : 'vertical',
      first: { groupId: sourceGroupId },
      second: { groupId }
    })
    expect(launch).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        requestedSurface: 'chat',
        selectedExecutionHostId: executionHostId,
        agent: 'codex',
        worktreeId,
        groupId,
        focusIntent: expect.objectContaining({ cancel: expect.any(Function) })
      })
    )
    expect(store.getState().unifiedTabsByWorktree[worktreeId]).toEqual([source])
    const layout = store.getState().layoutByWorktree[worktreeId]
    launch.mockReturnValue(null)
    expect(runNativeChatSplitTarget(target, direction)).toBe(true)
    expect(toast.error).toHaveBeenLastCalledWith('Could not build launch command for Codex.')
    expect(store.getState().layoutByWorktree[worktreeId]).toEqual(layout)
  }
)
