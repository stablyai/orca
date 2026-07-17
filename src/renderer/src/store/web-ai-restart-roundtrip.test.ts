// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getWebAiAccountWorkspaceId } from '../../../shared/constants'
import type { AppState } from './types'
import type { WebAiAccount } from '../../../shared/types'
import { parseWorkspaceSession } from '../../../shared/workspace-session-schema'
import { buildWorkspaceSessionPayload } from '../lib/workspace-session'
import { createTestStore, makeWorktree, TEST_REPO } from './slices/store-test-helpers'

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() }
}))

const account: WebAiAccount = {
  id: 'account-claude-work',
  provider: 'claude',
  label: 'Work Claude',
  executionHostId: 'local',
  profileId: 'profile-claude-work',
  sessionPartition: 'persist:orca-browser-session-profile-claude-work',
  createdAt: 1
}
const accountWorkspaceId = getWebAiAccountWorkspaceId(account.id)

function settings(): AppState['settings'] {
  return {
    activeRuntimeEnvironmentId: null,
    webAiAccounts: [account]
  } as AppState['settings']
}

describe('Web AI restart round trip', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        browser: {
          notifyActiveTabChanged: vi.fn().mockResolvedValue(undefined)
        }
      }
    })
  })

  it('restores multiple visible tabs, account identity, active selection, and group order', () => {
    const first = createTestStore()
    first.setState({ settings: settings(), activeWorktreeId: null })
    const firstWorkspace = first.getState().openWebAiAccount(account)
    const secondWorkspace = first.getState().openWebAiAccount(account, { openNewTab: true })
    if (!firstWorkspace || !secondWorkspace?.activePageId) {
      throw new Error('Expected two Web AI browser workspaces')
    }
    first
      .getState()
      .setBrowserPageUrl(secondWorkspace.activePageId, 'https://claude.ai/chat/example')

    const parsed = parseWorkspaceSession(
      JSON.parse(JSON.stringify(buildWorkspaceSessionPayload(first.getState())))
    )
    if (!parsed.ok) {
      throw new Error('Expected the serialized Web AI session to parse')
    }

    const restarted = createTestStore()
    restarted.setState({ settings: settings() })
    restarted.getState().hydrateWorkspaceSession(parsed.value)
    restarted.getState().hydrateTabsSession(parsed.value)
    restarted.getState().hydrateEditorSession(parsed.value)
    restarted.getState().hydrateBrowserSession(parsed.value)

    const state = restarted.getState()
    const restoredWorkspaces = state.browserTabsByWorktree[accountWorkspaceId] ?? []
    expect(restoredWorkspaces.map((workspace) => workspace.id)).toEqual([
      firstWorkspace.id,
      secondWorkspace.id
    ])
    expect(
      restoredWorkspaces.every(
        (workspace) => state.browserPagesByWorkspace[workspace.id]?.length === 1
      )
    ).toBe(true)
    expect(restoredWorkspaces).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          webAiAccountId: account.id,
          sessionProfileId: account.profileId,
          sessionPartition: account.sessionPartition
        }),
        expect.objectContaining({
          url: 'https://claude.ai/chat/example',
          webAiAccountId: account.id,
          sessionProfileId: account.profileId,
          sessionPartition: account.sessionPartition
        })
      ])
    )
    expect(state.unifiedTabsByWorktree[accountWorkspaceId]?.map((tab) => tab.entityId)).toEqual([
      firstWorkspace.id,
      secondWorkspace.id
    ])
    expect(state.groupsByWorktree[accountWorkspaceId]?.[0]?.tabOrder).toEqual(
      state.unifiedTabsByWorktree[accountWorkspaceId]?.map((tab) => tab.id)
    )
    const activeGroupId = state.activeGroupIdByWorktree[accountWorkspaceId]
    const activeGroup = state.groupsByWorktree[accountWorkspaceId]?.find(
      (group) => group.id === activeGroupId
    )
    const activeUnifiedTab = state.unifiedTabsByWorktree[accountWorkspaceId]?.find(
      (tab) => tab.id === activeGroup?.activeTabId
    )
    expect(activeUnifiedTab?.entityId).toBe(secondWorkspace.id)
    expect(state.activeBrowserTabIdByWorktree[accountWorkspaceId]).toBe(secondWorkspace.id)
    expect(state.activeWorktreeId).toBe(accountWorkspaceId)
    expect(state.activeTabType).toBe('browser')
    expect(
      restoredWorkspaces.every(
        (workspace) => state.browserPagesByWorkspace[workspace.id]?.length === 1
      )
    ).toBe(true)
    expect(state.groupsByWorktree[accountWorkspaceId]?.[0]?.activeTabId).toBe(
      state.unifiedTabsByWorktree[accountWorkspaceId]?.[1]?.id
    )

    expect(restarted.getState().openWebAiAccount(account)?.id).toBe(secondWorkspace.id)
    expect(restarted.getState().browserTabsByWorktree[accountWorkspaceId]).toHaveLength(2)
    restarted.getState().openWebAiAccount(account, { openNewTab: true })
    expect(restarted.getState().browserTabsByWorktree[accountWorkspaceId]).toHaveLength(3)
  })

  it('restores an account-bound conversation beside worktree tabs', () => {
    const worktreeId = 'wt-web-ai-project'
    const worktree = makeWorktree({ id: worktreeId, repoId: TEST_REPO.id })
    const integratedAccount: WebAiAccount = {
      ...account,
      id: 'account-chatgpt-personal',
      provider: 'chatgpt',
      label: 'Personal ChatGPT',
      profileId: 'profile-chatgpt-personal',
      sessionPartition: 'persist:orca-browser-session-profile-chatgpt-personal'
    }
    const integratedSettings = {
      activeRuntimeEnvironmentId: null,
      webAiAccounts: [integratedAccount]
    } as AppState['settings']
    const first = createTestStore()
    first.setState({
      settings: integratedSettings,
      repos: [TEST_REPO],
      worktreesByRepo: { [TEST_REPO.id]: [worktree] },
      activeWorktreeId: worktreeId
    })
    const terminal = first.getState().createTab(worktreeId)
    const browser = first.getState().openWebAiAccount(integratedAccount, {
      targetWorktreeId: worktreeId
    })
    if (!browser?.activePageId) {
      throw new Error('Expected an integrated Web AI browser workspace')
    }
    const conversationUrl = 'https://chatgpt.com/c/session-id'
    first.getState().setBrowserPageUrl(browser.activePageId, conversationUrl)

    const parsed = parseWorkspaceSession(
      JSON.parse(JSON.stringify(buildWorkspaceSessionPayload(first.getState())))
    )
    if (!parsed.ok) {
      throw new Error('Expected the integrated Web AI session to parse')
    }

    const restarted = createTestStore()
    restarted.setState({
      settings: integratedSettings,
      repos: [TEST_REPO],
      worktreesByRepo: { [TEST_REPO.id]: [worktree] }
    })
    restarted.getState().hydrateWorkspaceSession(parsed.value)
    restarted.getState().hydrateTabsSession(parsed.value)
    restarted.getState().hydrateEditorSession(parsed.value)
    restarted.getState().hydrateBrowserSession(parsed.value)

    const state = restarted.getState()
    const restoredBrowser = state.browserTabsByWorktree[worktreeId]?.[0]
    const restoredPage = restoredBrowser
      ? state.browserPagesByWorkspace[restoredBrowser.id]?.[0]
      : null
    const restoredUnifiedTabs = state.unifiedTabsByWorktree[worktreeId] ?? []
    const restoredBrowserTab = restoredUnifiedTabs.find(
      (tab) => tab.contentType === 'browser' && tab.entityId === restoredBrowser?.id
    )
    const restoredTerminalTab = restoredUnifiedTabs.find(
      (tab) => tab.contentType === 'terminal' && tab.entityId === terminal.id
    )

    expect(state.browserTabsByWorktree[accountWorkspaceId]).toBeUndefined()
    expect(restoredBrowser).toMatchObject({
      worktreeId,
      url: conversationUrl,
      webAiAccountId: integratedAccount.id,
      sessionProfileId: integratedAccount.profileId,
      sessionPartition: integratedAccount.sessionPartition
    })
    expect(restoredPage).toMatchObject({
      worktreeId,
      url: conversationUrl,
      browserRuntimeEnvironmentId: null
    })
    expect(restoredTerminalTab).toBeTruthy()
    expect(restoredBrowserTab).toBeTruthy()
    expect(
      state.groupsByWorktree[worktreeId]?.some(
        (group) =>
          group.tabOrder.includes(restoredTerminalTab?.id ?? '') &&
          group.tabOrder.includes(restoredBrowserTab?.id ?? '') &&
          group.activeTabId === restoredBrowserTab?.id
      )
    ).toBe(true)
    expect(state.activeWorktreeId).toBe(worktreeId)
    expect(state.activeBrowserTabId).toBe(restoredBrowser?.id)
    expect(state.activeTabType).toBe('browser')
  })

  it('drops an integrated session and its tab metadata when the saved account is gone', () => {
    const worktreeId = 'wt-removed-account'
    const worktree = makeWorktree({ id: worktreeId, repoId: TEST_REPO.id })
    const first = createTestStore()
    first.setState({
      settings: settings(),
      repos: [TEST_REPO],
      worktreesByRepo: { [TEST_REPO.id]: [worktree] },
      activeWorktreeId: worktreeId
    })
    const browser = first.getState().openWebAiAccount(account, {
      targetWorktreeId: worktreeId
    })
    if (!browser) {
      throw new Error('Expected an integrated Web AI browser workspace')
    }
    const parsed = parseWorkspaceSession(
      JSON.parse(JSON.stringify(buildWorkspaceSessionPayload(first.getState())))
    )
    if (!parsed.ok) {
      throw new Error('Expected the integrated Web AI session to parse')
    }

    const restarted = createTestStore()
    restarted.setState({
      settings: {
        activeRuntimeEnvironmentId: null,
        webAiAccounts: []
      } as unknown as AppState['settings'],
      repos: [TEST_REPO],
      worktreesByRepo: { [TEST_REPO.id]: [worktree] }
    })
    restarted.getState().hydrateWorkspaceSession(parsed.value)
    restarted.getState().hydrateTabsSession(parsed.value)
    restarted.getState().hydrateEditorSession(parsed.value)
    restarted.getState().hydrateBrowserSession(parsed.value)

    const state = restarted.getState()
    expect(state.browserTabsByWorktree[worktreeId]).toBeUndefined()
    expect(state.browserPagesByWorkspace[browser.id]).toBeUndefined()
    expect(
      (state.unifiedTabsByWorktree[worktreeId] ?? []).some(
        (tab) => tab.contentType === 'browser' && tab.entityId === browser.id
      )
    ).toBe(false)
  })

  it('migrates legacy hidden pages beside their source tab without stealing focus', () => {
    const first = createTestStore()
    first.setState({ settings: settings(), activeWorktreeId: null })
    const workspace = first.getState().openWebAiAccount(account)
    if (!workspace) {
      throw new Error('Expected a Web AI browser workspace')
    }
    const legacyActivePage = first
      .getState()
      .createBrowserPage(workspace.id, 'https://claude.ai/chat/legacy', {
        title: 'Legacy conversation'
      })
    if (!legacyActivePage) {
      throw new Error('Expected a legacy hidden browser page')
    }
    const beforeWorkspace = first.getState().openWebAiAccount(account, { openNewTab: true })
    const afterWorkspace = first.getState().openWebAiAccount(account, { openNewTab: true })
    if (!beforeWorkspace?.activePageId || !afterWorkspace?.activePageId) {
      throw new Error('Expected neighboring Web AI browser workspaces')
    }
    first
      .getState()
      .setBrowserPageUrl(beforeWorkspace.activePageId, 'https://claude.ai/chat/before')
    first.getState().setBrowserPageUrl(afterWorkspace.activePageId, 'https://claude.ai/chat/after')

    const initialTabs = first.getState().unifiedTabsByWorktree[accountWorkspaceId] ?? []
    const sourceUnifiedTab = initialTabs.find((tab) => tab.entityId === workspace.id)
    const beforeUnifiedTab = initialTabs.find((tab) => tab.entityId === beforeWorkspace.id)
    const afterUnifiedTab = initialTabs.find((tab) => tab.entityId === afterWorkspace.id)
    if (!sourceUnifiedTab || !beforeUnifiedTab || !afterUnifiedTab) {
      throw new Error('Expected unified tabs for the legacy migration fixture')
    }
    first
      .getState()
      .reorderUnifiedTabs(
        sourceUnifiedTab.groupId,
        [beforeUnifiedTab.id, sourceUnifiedTab.id, afterUnifiedTab.id],
        { recordInteraction: false }
      )
    const splitGroupId = first
      .getState()
      .createEmptySplitGroup(accountWorkspaceId, sourceUnifiedTab.groupId, 'right')
    if (!splitGroupId) {
      throw new Error('Expected a second Web AI tab group')
    }
    const activeWorkspace = first.getState().openWebAiAccount(account, {
      openNewTab: true,
      targetGroupId: splitGroupId
    })
    if (!activeWorkspace?.activePageId) {
      throw new Error('Expected an active Web AI workspace in the second group')
    }
    first
      .getState()
      .setBrowserPageUrl(activeWorkspace.activePageId, 'https://claude.ai/chat/active')

    const parsed = parseWorkspaceSession(
      JSON.parse(JSON.stringify(buildWorkspaceSessionPayload(first.getState())))
    )
    if (!parsed.ok) {
      throw new Error('Expected the legacy Web AI session to parse')
    }

    const restarted = createTestStore()
    restarted.setState({ settings: settings() })
    restarted.getState().hydrateWorkspaceSession(parsed.value)
    restarted.getState().hydrateTabsSession(parsed.value)
    restarted.getState().hydrateEditorSession(parsed.value)
    restarted.getState().hydrateBrowserSession(parsed.value)

    const state = restarted.getState()
    const workspaces = state.browserTabsByWorktree[accountWorkspaceId] ?? []
    const tabs = state.unifiedTabsByWorktree[accountWorkspaceId] ?? []
    const sourceTab = tabs.find((tab) => tab.entityId === workspace.id)
    const sourceGroup = state.groupsByWorktree[accountWorkspaceId]?.find(
      (entry) => entry.id === sourceTab?.groupId
    )
    const orderedWorkspaceUrls = (sourceGroup?.tabOrder ?? []).flatMap((tabId) => {
      const entityId = tabs.find((tab) => tab.id === tabId)?.entityId
      const restoredWorkspace = workspaces.find((entry) => entry.id === entityId)
      return restoredWorkspace ? [restoredWorkspace.url] : []
    })
    const activeTab = tabs.find((tab) => tab.entityId === activeWorkspace.id)

    expect(workspaces).toHaveLength(5)
    expect(workspaces.every((entry) => state.browserPagesByWorkspace[entry.id]?.length === 1)).toBe(
      true
    )
    expect(orderedWorkspaceUrls).toEqual([
      'https://claude.ai/chat/before',
      'https://claude.ai/',
      'https://claude.ai/chat/legacy',
      'https://claude.ai/chat/after'
    ])
    expect(sourceGroup?.activeTabId).toBe(afterUnifiedTab.id)
    expect(state.activeGroupIdByWorktree[accountWorkspaceId]).toBe(activeTab?.groupId)
    expect(
      state.groupsByWorktree[accountWorkspaceId]?.find((entry) => entry.id === activeTab?.groupId)
        ?.activeTabId
    ).toBe(activeTab?.id)
    expect(state.activeBrowserTabIdByWorktree[accountWorkspaceId]).toBe(activeWorkspace.id)
    expect(workspaces.find((entry) => entry.id === workspace.id)?.activePageId).toBe(
      legacyActivePage.id
    )

    const migratedWorkspaceIds = workspaces.map((entry) => entry.id)
    const migratedUnifiedTabIds = tabs.map((tab) => tab.id)
    restarted.getState().hydrateBrowserSession(parsed.value)
    expect(
      restarted.getState().browserTabsByWorktree[accountWorkspaceId]?.map((entry) => entry.id)
    ).toEqual(migratedWorkspaceIds)
    expect(
      restarted.getState().unifiedTabsByWorktree[accountWorkspaceId]?.map((tab) => tab.id)
    ).toEqual(migratedUnifiedTabIds)

    const independentlyRestarted = createTestStore()
    independentlyRestarted.setState({ settings: settings() })
    independentlyRestarted.getState().hydrateWorkspaceSession(parsed.value)
    independentlyRestarted.getState().hydrateTabsSession(parsed.value)
    independentlyRestarted.getState().hydrateEditorSession(parsed.value)
    independentlyRestarted.getState().hydrateBrowserSession(parsed.value)
    expect(
      independentlyRestarted
        .getState()
        .browserTabsByWorktree[accountWorkspaceId]?.map((entry) => entry.id)
    ).toEqual(migratedWorkspaceIds)
    expect(
      independentlyRestarted
        .getState()
        .unifiedTabsByWorktree[accountWorkspaceId]?.map((tab) => tab.id)
    ).toEqual(migratedUnifiedTabIds)
  })
})
