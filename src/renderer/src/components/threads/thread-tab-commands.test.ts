// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { getDefaultSettings } from '../../../../shared/constants'
import { makeTabGroup, makeUnifiedTab } from '@/store/slices/store-test-helpers'
import { dispatchWorkspaceTabCommand } from '@/lib/workspace-tab-commands'
import { publishStructuredSessionSummaries } from '../native-chat/structured-session-summary-store'
import { clearThreadSelection, useThreadNavigation } from './thread-navigation'

const closeItem = vi.hoisted(() => vi.fn())
vi.mock('@/components/tab-group/workspace-tab-close-commands', () => ({
  createWorkspaceTabCloseCommands: () => ({ closeItem })
}))
vi.mock('@/store/pinned-tab-close-guard', () => ({
  guardPinnedTabClose: ({ onClose }: { onClose: () => void }) => onClose(),
  resolvePinnedTabLabel: () => 'Chat'
}))
vi.mock('@/components/tab-group/workspace-emptied-reaction', () => ({
  captureWorkspaceEmptiedReaction: () => vi.fn()
}))
vi.mock('@/lib/floating-workspace-terminal-actions', () => ({
  isFloatingWorkspacePanelFocused: () => false
}))

afterEach(() => {
  clearThreadSelection()
  publishStructuredSessionSummaries([{ tabId: 'thread', summary: null }])
  vi.clearAllMocks()
})
it('closes the selected thread rather than a retained host tab, and leaves host cycling alone', () => {
  const host = makeUnifiedTab({ id: 'host', worktreeId: 'main', contentType: 'agent-session' })
  const thread = makeUnifiedTab({ id: 'thread', worktreeId: 'main', contentType: 'agent-session' })
  const settings = getDefaultSettings('/tmp/threads-tab-commands')
  useAppStore.setState({
    activeView: 'terminal',
    activeWorktreeId: 'main',
    settings: { ...settings, experimentalThreads: true },
    unifiedTabsByWorktree: { main: [host, thread] },
    groupsByWorktree: {
      main: [
        makeTabGroup({
          id: 'g',
          worktreeId: 'main',
          activeTabId: thread.id,
          tabOrder: [host.id, thread.id]
        })
      ]
    },
    activeGroupIdByWorktree: { main: 'g' },
    getActiveTab: () => host
  })
  publishStructuredSessionSummaries([
    {
      tabId: thread.id,
      tab: thread,
      summary: {
        surface: 'thread',
        sessionId: thread.entityId,
        workspaceId: 'main',
        agent: 'codex',
        status: 'idle',
        latestPrompt: '',
        updatedAt: 1
      }
    }
  ])
  expect(dispatchWorkspaceTabCommand({ type: 'close' })).toBe(true)
  expect(closeItem).toHaveBeenLastCalledWith(thread.id, expect.any(Object))
  expect(dispatchWorkspaceTabCommand({ type: 'switch', direction: 1, scope: 'all-types' })).toBe(
    false
  )
  useAppStore.setState({ settings: { ...settings, experimentalThreads: false } })
  expect(dispatchWorkspaceTabCommand({ type: 'close' })).toBe(true)
  expect(closeItem).toHaveBeenLastCalledWith(thread.id, expect.any(Object))
})
it('dismisses a new-thread screen without closing the host chat', () => {
  useAppStore.setState({
    activeView: 'terminal',
    settings: { ...getDefaultSettings('/tmp/threads-tab-commands'), experimentalThreads: true }
  })
  useThreadNavigation.setState({
    selection: { kind: 'new', projectKey: 'project', draftId: 'draft' }
  })
  expect(dispatchWorkspaceTabCommand({ type: 'close' })).toBe(true)
  expect(useThreadNavigation.getState().selection).toBeNull()
  expect(closeItem).not.toHaveBeenCalled()
})
