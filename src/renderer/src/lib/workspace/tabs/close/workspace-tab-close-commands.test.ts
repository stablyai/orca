// @vitest-environment happy-dom
// A busy chat tab's "x" asks "Stop the agent in this chat?" only where closing stops it: a bot home's
// chats close to the background, so they close without asking.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tab } from '../../../../../../shared/workspace-layout/tab-groups/tab-types'
import { folderWorkspaceKey } from '../../../../../../shared/workspace/identity/workspace-scope'

const bots = vi.hoisted((): { list: { folderWorkspaceId: string }[] } => ({ list: [] }))
vi.mock('@/lib/bot-catalog-snapshot', () => ({ readBots: () => bots.list }))
// The agent in every tab here is mid-reply.
vi.mock('@/lib/agent-session/structured-agent-session-busy', () => ({
  admitStructuredAgentSession: async (
    _workspaceId: string,
    _tab: Tab,
    _intent: string,
    effect: (busy: boolean, attempt: { current: () => boolean }) => void | Promise<void>
  ) => effect(true, { current: () => true })
}))

import { useAppStore } from '../../../../store/index'
import { useRunningTerminalCloseConfirmStore } from '@/store/slices/tabs/closing/running-terminal-close-confirm'
import { createWorkspaceTabCloseCommands } from './workspace-tab-close-commands'

const HOME = 'atlas-home'

function chatTab(worktreeId: string): Tab {
  return {
    id: `${worktreeId}-chat`,
    entityId: 'session-1',
    groupId: 'group-1',
    worktreeId,
    contentType: 'agent-session',
    label: 'Water the lawn',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 1,
    isPreview: false,
    isPinned: false
  }
}

/** Clicks the tab's "x"; answers whether it closed and whether the stop prompt came up. */
async function closeBusyChat(
  worktreeId: string,
  botsEnabled = true
): Promise<{ closed: boolean; asked: boolean }> {
  const tab = chatTab(worktreeId)
  const closeUnifiedTab = vi.fn((tabId: string) => ({
    closedTabId: tabId,
    wasLastTab: true,
    worktreeId
  }))
  useAppStore.setState({
    closeUnifiedTab,
    settings: { ...useAppStore.getState().settings!, botsEnabled },
    unifiedTabsByWorktree: { [worktreeId]: [tab] }
  })
  createWorkspaceTabCloseCommands({ worktreeId, groupTabs: [tab] }).closeItem(tab.id)
  await new Promise((resolve) => setTimeout(resolve, 0))
  return {
    closed: closeUnifiedTab.mock.calls.length > 0,
    asked: useRunningTerminalCloseConfirmStore.getState().runningTerminalCloseConfirm !== null
  }
}

describe("a busy chat tab's x", () => {
  const initial = useAppStore.getState()

  beforeEach(() => {
    bots.list = [{ folderWorkspaceId: HOME }]
  })

  afterEach(() => {
    useAppStore.setState(initial, true)
    useRunningTerminalCloseConfirmStore.getState().dismissRunningTerminalClose()
  })

  it('closes a bot home chat to the background without asking to stop the agent', async () => {
    expect(await closeBusyChat(folderWorkspaceKey(HOME))).toEqual({ closed: true, asked: false })
  })

  it('still asks for any other chat, and for a bot home with bots off', async () => {
    expect(await closeBusyChat('plain-folder')).toEqual({ closed: false, asked: true })
    useRunningTerminalCloseConfirmStore.getState().dismissRunningTerminalClose()
    expect(await closeBusyChat(folderWorkspaceKey(HOME), false)).toEqual({
      closed: false,
      asked: true
    })
  })
})
