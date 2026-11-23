// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { makeFolderWorkspace } from '@/store/folder-workspaces/folder-workspace.test-fixture'
import { publishBotGroups } from '@/lib/bot-group-catalog-snapshot'
import type { BotGroup } from '../../../../shared/bots/bot-group'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../../../shared/agent-session/view/structured-agent-session-projection'
import { useBotGroupRoomRead } from './use-bot-group-room-read'
import { makeUnifiedTab } from '../../store/slices/tabs/tab-group.test-fixture'

vi.mock('@/attention/orca-window-foreground-focus', () => ({
  isOrcaWindowForegroundFocused: () => true
}))

const original = useAppStore.getState()

describe('useBotGroupRoomRead', () => {
  afterEach(() => {
    useAppStore.setState(original, true)
    publishBotGroups([])
  })

  it('reads a reply that lands while the room is open, and leaves a hidden room unread', () => {
    const read = vi.fn()
    useAppStore.setState({
      folderWorkspaces: [makeFolderWorkspace({ id: 'group-home' })],
      readOnScreenAttention: read
    })
    const { rerender } = renderHook(({ visible }) => useBotGroupRoomRead('group-home', visible), {
      initialProps: { visible: false }
    })
    act(() =>
      useAppStore.setState({
        folderWorkspaces: [makeFolderWorkspace({ id: 'group-home', isUnread: true })]
      })
    )
    expect(read).not.toHaveBeenCalled()
    rerender({ visible: true })
    expect(read).toHaveBeenCalledWith(
      { workspaceIds: ['folder:group-home'], targets: [] },
      { screenArrived: true }
    )
  })

  it("leaves a hidden thread's reply unread while the original room is on screen", () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only rooms and home are read.
    const group = {
      id: 'group-1',
      folderWorkspaceId: 'group-home',
      members: [{ botId: 'scout', sessionId: 'bot-group-member-main' }],
      threads: [
        {
          id: 'thread-1',
          createdAt: 1,
          members: [{ botId: 'scout', sessionId: 'bot-group-member-thread' }]
        }
      ]
    } as BotGroup
    publishBotGroups([group])
    const room = (id: string, entityId: string) =>
      makeUnifiedTab({
        id,
        entityId,
        worktreeId: 'folder:group-home',
        groupId: 'g',
        contentType: 'room'
      })
    useAppStore.setState({
      folderWorkspaces: [makeFolderWorkspace({ id: 'group-home' })],
      updateFolderWorkspace: async () => true,
      unifiedTabsByWorktree: {
        'folder:group-home': [room('main-tab', 'group-1'), room('thread-tab', 'thread-1')]
      },
      unreadTerminalTabs: {},
      unreadTerminalPanes: {},
      unreadAgentCompletionPanes: {}
    })
    renderHook(() => useBotGroupRoomRead('group-home', true))
    // The thread member's completion, as native chat attention marks it.
    act(() =>
      useAppStore.getState().markAgentAttentionUnread({
        workspaceId: 'folder:group-home',
        subjectKey: structuredAgentSessionPaneKey(
          structuredAgentSessionTabId('bot-group-member-thread'),
          'bot-group-member-thread'
        ),
        groupId: null,
        reason: 'agent-completion'
      })
    )
    expect(useAppStore.getState().folderWorkspaces[0]?.isUnread).toBe(true)
  })
})
