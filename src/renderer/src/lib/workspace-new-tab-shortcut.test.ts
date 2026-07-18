import { describe, expect, it, vi } from 'vitest'
import { getWebAiAccountWorkspaceId, WEB_AI_BROWSER_WORKSPACE_ID } from '../../../shared/constants'
import { dispatchWorkspaceNewTabShortcut } from './workspace-new-tab-shortcut'

describe('dispatchWorkspaceNewTabShortcut', () => {
  it.each([getWebAiAccountWorkspaceId('chatgpt-main'), WEB_AI_BROWSER_WORKSPACE_ID])(
    'opens a browser tab for Web AI workspace %s',
    (workspaceId) => {
      const openBrowserTab = vi.fn()
      const openTerminalTab = vi.fn()

      expect(
        dispatchWorkspaceNewTabShortcut(workspaceId, { openBrowserTab, openTerminalTab })
      ).toBe('browser')
      expect(openBrowserTab).toHaveBeenCalledTimes(1)
      expect(openTerminalTab).not.toHaveBeenCalled()
    }
  )

  it('opens a terminal tab for a project workspace', () => {
    const openBrowserTab = vi.fn()
    const openTerminalTab = vi.fn()

    expect(dispatchWorkspaceNewTabShortcut('worktree-1', { openBrowserTab, openTerminalTab })).toBe(
      'terminal'
    )
    expect(openTerminalTab).toHaveBeenCalledTimes(1)
    expect(openBrowserTab).not.toHaveBeenCalled()
  })

  it('opens the same Web AI account when its browser tab is active in a project worktree', () => {
    const openBrowserTab = vi.fn()
    const openTerminalTab = vi.fn()
    const openWebAiAccountTab = vi.fn()
    const account = {
      id: 'account-1',
      provider: 'chatgpt' as const,
      label: 'Personal ChatGPT',
      executionHostId: 'local' as const,
      profileId: 'profile-1',
      sessionPartition: 'persist:profile-1',
      createdAt: 1
    }

    expect(
      dispatchWorkspaceNewTabShortcut(
        'worktree-1',
        { openBrowserTab, openTerminalTab, openWebAiAccountTab },
        {
          activeBrowserTabId: 'browser-1',
          activeTabType: 'browser',
          browserTabsByWorktree: {
            'worktree-1': [
              {
                id: 'browser-1',
                worktreeId: 'worktree-1',
                url: 'https://chatgpt.com/c/conversation-1',
                title: 'Conversation',
                loading: false,
                faviconUrl: null,
                canGoBack: false,
                canGoForward: false,
                loadError: null,
                createdAt: 1,
                webAiAccountId: account.id,
                sessionProfileId: account.profileId,
                sessionPartition: account.sessionPartition
              }
            ]
          },
          webAiAccounts: [account]
        }
      )
    ).toBe('browser')
    expect(openWebAiAccountTab).toHaveBeenCalledWith(account)
    expect(openBrowserTab).not.toHaveBeenCalled()
    expect(openTerminalTab).not.toHaveBeenCalled()
  })

  it('fails closed to a terminal when the active account binding has drifted', () => {
    const openBrowserTab = vi.fn()
    const openTerminalTab = vi.fn()
    const account = {
      id: 'account-1',
      provider: 'chatgpt' as const,
      label: 'Personal ChatGPT',
      executionHostId: 'local' as const,
      profileId: 'profile-1',
      sessionPartition: 'persist:profile-1',
      createdAt: 1
    }

    expect(
      dispatchWorkspaceNewTabShortcut(
        'worktree-1',
        { openBrowserTab, openTerminalTab },
        {
          activeBrowserTabId: 'browser-1',
          activeTabType: 'browser',
          browserTabsByWorktree: {
            'worktree-1': [
              {
                id: 'browser-1',
                worktreeId: 'worktree-1',
                url: 'https://chatgpt.com/',
                title: 'ChatGPT',
                loading: false,
                faviconUrl: null,
                canGoBack: false,
                canGoForward: false,
                loadError: null,
                createdAt: 1,
                webAiAccountId: account.id,
                sessionProfileId: account.profileId,
                sessionPartition: 'persist:wrong-profile'
              }
            ]
          },
          webAiAccounts: [account]
        }
      )
    ).toBe('terminal')
    expect(openTerminalTab).toHaveBeenCalledTimes(1)
    expect(openBrowserTab).not.toHaveBeenCalled()
  })
})
