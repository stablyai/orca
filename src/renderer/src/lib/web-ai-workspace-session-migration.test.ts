import { describe, expect, it } from 'vitest'
import {
  WEB_AI_BROWSER_WORKSPACE_ID,
  getDefaultWorkspaceSession,
  getWebAiAccountWorkspaceId
} from '../../../shared/constants'
import type {
  BrowserPage,
  BrowserWorkspace,
  Tab,
  TabGroup,
  WebAiAccount,
  WorkspaceSessionState
} from '../../../shared/types'
import { parseWorkspaceSession } from '../../../shared/workspace-session-schema'
import { worktreeWorkspaceKey } from '../../../shared/workspace-scope'
import { migrateLegacyWebAiWorkspaceSession } from './web-ai-workspace-session-migration'

const chatAccount: WebAiAccount = {
  id: 'account-chat',
  provider: 'chatgpt',
  label: 'Personal ChatGPT',
  executionHostId: 'local',
  profileId: 'profile-chat',
  sessionPartition: 'persist:profile-chat',
  createdAt: 1
}

const claudeAccount: WebAiAccount = {
  id: 'account-claude',
  provider: 'claude',
  label: 'Work Claude',
  executionHostId: 'local',
  profileId: 'profile-claude',
  sessionPartition: 'persist:profile-claude',
  createdAt: 2
}

function browserWorkspace(
  id: string,
  account: WebAiAccount,
  overrides: Partial<BrowserWorkspace> = {}
): BrowserWorkspace {
  const pageId = `${id}-page`
  return {
    id,
    worktreeId: WEB_AI_BROWSER_WORKSPACE_ID,
    sessionProfileId: account.profileId,
    sessionPartition: account.sessionPartition,
    webAiAccountId: account.id,
    activePageId: pageId,
    pageIds: [pageId],
    url: account.provider === 'chatgpt' ? 'https://chatgpt.com/' : 'https://claude.ai/',
    title: account.label,
    loading: false,
    faviconUrl: null,
    canGoBack: false,
    canGoForward: false,
    loadError: null,
    createdAt: account.createdAt,
    ...overrides
  }
}

function browserPage(workspace: BrowserWorkspace): BrowserPage {
  return {
    id: workspace.activePageId!,
    workspaceId: workspace.id,
    worktreeId: workspace.worktreeId,
    url: workspace.url,
    title: workspace.title,
    loading: false,
    faviconUrl: null,
    canGoBack: false,
    canGoForward: false,
    loadError: null,
    createdAt: workspace.createdAt
  }
}

function browserTab(id: string, workspaceId: string, groupId: string, sortOrder: number): Tab {
  return {
    id,
    entityId: workspaceId,
    groupId,
    worktreeId: WEB_AI_BROWSER_WORKSPACE_ID,
    contentType: 'browser',
    label: workspaceId,
    customLabel: null,
    color: null,
    sortOrder,
    createdAt: sortOrder + 1
  }
}

function group(id: string, tabOrder: string[], activeTabId: string): TabGroup {
  return {
    id,
    worktreeId: WEB_AI_BROWSER_WORKSPACE_ID,
    activeTabId,
    tabOrder,
    recentTabIds: [...tabOrder]
  }
}

function legacyMixedAccountSession(): WorkspaceSessionState {
  const chatFirst = browserWorkspace('chat-first', chatAccount)
  const claude = browserWorkspace('claude-main', claudeAccount)
  const chatSecond = browserWorkspace('chat-second', chatAccount, {
    url: 'https://chatgpt.com/c/example'
  })
  const invalid = browserWorkspace('invalid-binding', chatAccount, {
    sessionPartition: 'persist:wrong-profile'
  })
  const mainOrder = ['tab-chat-first', 'tab-claude', 'tab-invalid']
  return {
    ...getDefaultWorkspaceSession(),
    activeRepoId: null,
    activeWorktreeId: WEB_AI_BROWSER_WORKSPACE_ID,
    activeWorkspaceKey: worktreeWorkspaceKey(WEB_AI_BROWSER_WORKSPACE_ID),
    activeTabId: 'tab-claude',
    tabsByWorktree: { [WEB_AI_BROWSER_WORKSPACE_ID]: [] },
    activeWorktreeIdsOnShutdown: [WEB_AI_BROWSER_WORKSPACE_ID, 'wt-live'],
    openFilesByWorktree: { [WEB_AI_BROWSER_WORKSPACE_ID]: [] },
    activeFileIdByWorktree: { [WEB_AI_BROWSER_WORKSPACE_ID]: 'stale-file' },
    browserTabsByWorktree: {
      [WEB_AI_BROWSER_WORKSPACE_ID]: [chatFirst, claude, invalid, chatSecond]
    },
    browserPagesByWorkspace: Object.fromEntries(
      [chatFirst, claude, invalid, chatSecond].map((workspace) => [
        workspace.id,
        [browserPage(workspace)]
      ])
    ),
    activeBrowserTabIdByWorktree: { [WEB_AI_BROWSER_WORKSPACE_ID]: claude.id },
    activeTabTypeByWorktree: { [WEB_AI_BROWSER_WORKSPACE_ID]: 'browser' },
    activeTabIdByWorktree: { [WEB_AI_BROWSER_WORKSPACE_ID]: null },
    unifiedTabs: {
      [WEB_AI_BROWSER_WORKSPACE_ID]: [
        browserTab('tab-chat-first', chatFirst.id, 'group-main', 0),
        browserTab('tab-claude', claude.id, 'group-main', 1),
        browserTab('tab-invalid', invalid.id, 'group-main', 2),
        browserTab('tab-chat-second', chatSecond.id, 'group-side', 3)
      ]
    },
    tabGroups: {
      [WEB_AI_BROWSER_WORKSPACE_ID]: [
        group('group-main', mainOrder, 'tab-claude'),
        group('group-side', ['tab-chat-second'], 'tab-chat-second')
      ]
    },
    tabGroupLayouts: {
      [WEB_AI_BROWSER_WORKSPACE_ID]: {
        type: 'split',
        direction: 'horizontal',
        first: { type: 'leaf', groupId: 'group-main' },
        second: { type: 'leaf', groupId: 'group-side' },
        ratio: 0.6
      }
    },
    activeGroupIdByWorktree: { [WEB_AI_BROWSER_WORKSPACE_ID]: 'group-main' },
    lastVisitedAtByWorktreeId: { [WEB_AI_BROWSER_WORKSPACE_ID]: 1234 },
    defaultTerminalTabsAppliedByWorktreeId: { [WEB_AI_BROWSER_WORKSPACE_ID]: true }
  }
}

describe('migrateLegacyWebAiWorkspaceSession', () => {
  it('splits mixed legacy browser topology into deterministic account workspaces', () => {
    const migrated = migrateLegacyWebAiWorkspaceSession(legacyMixedAccountSession(), [
      chatAccount,
      claudeAccount
    ])
    const chatWorkspaceId = getWebAiAccountWorkspaceId(chatAccount.id)
    const claudeWorkspaceId = getWebAiAccountWorkspaceId(claudeAccount.id)

    expect(migrated.browserTabsByWorktree?.[WEB_AI_BROWSER_WORKSPACE_ID]).toBeUndefined()
    expect(migrated.browserTabsByWorktree?.[chatWorkspaceId]?.map((tab) => tab.id)).toEqual([
      'chat-first',
      'chat-second'
    ])
    expect(migrated.browserTabsByWorktree?.[claudeWorkspaceId]?.map((tab) => tab.id)).toEqual([
      'claude-main'
    ])
    expect(
      migrated.browserTabsByWorktree?.[chatWorkspaceId]?.every(
        (workspace) => workspace.worktreeId === chatWorkspaceId
      )
    ).toBe(true)
    expect(migrated.browserPagesByWorkspace?.['chat-first']?.[0]?.worktreeId).toBe(chatWorkspaceId)
    expect(migrated.browserPagesByWorkspace?.['claude-main']?.[0]?.worktreeId).toBe(
      claudeWorkspaceId
    )
    expect(migrated.browserPagesByWorkspace?.['invalid-binding']).toBeUndefined()

    expect(migrated.unifiedTabs?.[chatWorkspaceId]?.map((tab) => tab.id)).toEqual([
      'tab-chat-first',
      'tab-chat-second'
    ])
    expect(migrated.unifiedTabs?.[claudeWorkspaceId]?.map((tab) => tab.id)).toEqual(['tab-claude'])
    expect(
      migrated.unifiedTabs?.[chatWorkspaceId]?.every((tab) => tab.worktreeId === chatWorkspaceId)
    ).toBe(true)
    expect(migrated.tabGroups?.[chatWorkspaceId]?.map((entry) => entry.tabOrder)).toEqual([
      ['tab-chat-first'],
      ['tab-chat-second']
    ])
    expect(migrated.tabGroupLayouts?.[chatWorkspaceId]?.type).toBe('split')
    expect(migrated.tabGroupLayouts?.[claudeWorkspaceId]?.type).toBe('leaf')
    expect(migrated.tabGroups?.[chatWorkspaceId]?.[0]?.id).not.toBe(
      migrated.tabGroups?.[claudeWorkspaceId]?.[0]?.id
    )

    expect(migrated.activeWorktreeId).toBe(claudeWorkspaceId)
    expect(migrated.activeWorkspaceKey).toBe(worktreeWorkspaceKey(claudeWorkspaceId))
    expect(migrated.activeTabId).toBe('tab-claude')
    expect(migrated.activeBrowserTabIdByWorktree?.[claudeWorkspaceId]).toBe('claude-main')
    expect(migrated.activeTabTypeByWorktree?.[chatWorkspaceId]).toBe('browser')
    expect(migrated.activeTabTypeByWorktree?.[claudeWorkspaceId]).toBe('browser')
    expect(migrated.lastVisitedAtByWorktreeId).toEqual({ [claudeWorkspaceId]: 1234 })
    expect(migrated.activeWorktreeIdsOnShutdown).toEqual(['wt-live'])
    expect(migrated.tabsByWorktree[WEB_AI_BROWSER_WORKSPACE_ID]).toBeUndefined()
    expect(migrated.openFilesByWorktree?.[WEB_AI_BROWSER_WORKSPACE_ID]).toBeUndefined()
    expect(
      migrated.defaultTerminalTabsAppliedByWorktreeId?.[WEB_AI_BROWSER_WORKSPACE_ID]
    ).toBeUndefined()
    expect(parseWorkspaceSession(migrated).ok).toBe(true)

    expect(migrateLegacyWebAiWorkspaceSession(migrated, [chatAccount, claudeAccount])).toBe(
      migrated
    )
  })

  it('drops invalid bindings and keeps an already-migrated target authoritative', () => {
    const legacy = browserWorkspace('legacy-chat', chatAccount)
    const targetWorkspaceId = getWebAiAccountWorkspaceId(chatAccount.id)
    const existing = browserWorkspace('existing-chat', chatAccount, {
      worktreeId: targetWorkspaceId
    })
    const session: WorkspaceSessionState = {
      ...getDefaultWorkspaceSession(),
      activeRepoId: null,
      activeWorktreeId: WEB_AI_BROWSER_WORKSPACE_ID,
      activeWorkspaceKey: worktreeWorkspaceKey(WEB_AI_BROWSER_WORKSPACE_ID),
      browserTabsByWorktree: {
        [WEB_AI_BROWSER_WORKSPACE_ID]: [legacy],
        [targetWorkspaceId]: [existing]
      },
      browserPagesByWorkspace: {
        [legacy.id]: [browserPage(legacy)],
        [existing.id]: [browserPage(existing)]
      },
      activeBrowserTabIdByWorktree: {
        [WEB_AI_BROWSER_WORKSPACE_ID]: legacy.id,
        [targetWorkspaceId]: existing.id
      },
      activeTabTypeByWorktree: {
        [WEB_AI_BROWSER_WORKSPACE_ID]: 'browser',
        [targetWorkspaceId]: 'browser'
      }
    }

    const migrated = migrateLegacyWebAiWorkspaceSession(session, [chatAccount])

    expect(migrated.browserTabsByWorktree?.[targetWorkspaceId]).toEqual([existing])
    expect(migrated.browserPagesByWorkspace?.[legacy.id]).toBeUndefined()
    expect(migrated.browserPagesByWorkspace?.[existing.id]).toEqual([browserPage(existing)])
    expect(migrated.activeWorktreeId).toBe(targetWorkspaceId)
    expect(migrated.activeBrowserTabIdByWorktree?.[targetWorkspaceId]).toBe(existing.id)
  })

  it('returns the original reference when no legacy workspace state exists', () => {
    const session = getDefaultWorkspaceSession()

    expect(migrateLegacyWebAiWorkspaceSession(session, [chatAccount])).toBe(session)
  })
})
