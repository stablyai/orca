// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserSessionProfile, WebAiAccount } from '../../../../shared/types'
import { getWebAiAccountWorkspaceId } from '../../../../shared/constants'
import { TooltipProvider } from '@/components/ui/tooltip'
import WebAiAccountsSection from './WebAiAccountsSection'

const mocks = vi.hoisted(() => {
  const holder = { state: {} as Record<string, unknown> }
  const useAppStore = Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) => selector(holder.state),
    { getState: () => holder.state }
  )
  return {
    holder,
    useAppStore,
    launchWebAiAccount: vi.fn(),
    deleteWebAiAccount: vi.fn(),
    setWebAiAccountsCollapsed: vi.fn(),
    updateSettings: vi.fn(),
    openSettingsPage: vi.fn(),
    openSettingsTarget: vi.fn(),
    switchRuntimeEnvironment: vi.fn()
  }
})

vi.mock('@/store', () => ({ useAppStore: mocks.useAppStore }))

vi.mock('@/components/status-bar/icons', () => ({
  OpenAIIcon: () => <span data-testid="openai-icon" />,
  ClaudeIcon: () => <span data-testid="claude-icon" />
}))

const profile: BrowserSessionProfile = {
  id: 'profile-1',
  scope: 'isolated',
  partition: 'persist:profile-1',
  label: 'Personal browser',
  source: null
}

const account: WebAiAccount = {
  id: 'account-1',
  provider: 'chatgpt',
  label: 'Personal ChatGPT',
  executionHostId: 'local',
  profileId: profile.id,
  sessionPartition: profile.partition,
  createdAt: 1
}
const accountWorkspaceId = getWebAiAccountWorkspaceId(account.id)

describe('WebAiAccountsSection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.holder.state = {
      settings: { webAiAccounts: [account], activeRuntimeEnvironmentId: null },
      updateSettings: mocks.updateSettings,
      launchWebAiAccount: mocks.launchWebAiAccount.mockResolvedValue({
        ok: true,
        workspace: { id: 'workspace-1' },
        profiles: [profile]
      }),
      deleteWebAiAccount: mocks.deleteWebAiAccount,
      browserTabsByWorktree: {},
      browserPagesByWorkspace: {},
      activeBrowserTabId: null,
      activeWorktreeId: 'wt-1',
      activeTabType: 'terminal',
      activeView: 'terminal',
      webAiAccountsCollapsed: false,
      setWebAiAccountsCollapsed: mocks.setWebAiAccountsCollapsed,
      openSettingsPage: mocks.openSettingsPage,
      openSettingsTarget: mocks.openSettingsTarget,
      switchRuntimeEnvironment: mocks.switchRuntimeEnvironment.mockResolvedValue(true),
      fetchBrowserSessionProfiles: vi.fn()
    }
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        browser: {
          sessionListProfiles: vi.fn().mockResolvedValue([profile]),
          sessionCreateProfile: vi.fn(),
          sessionDeleteProfile: vi.fn()
        }
      }
    })
  })

  afterEach(() => {
    cleanup()
    Reflect.deleteProperty(window, 'api')
  })

  it('opens the saved identity and can add another visible browser tab', async () => {
    const user = userEvent.setup()
    render(
      <TooltipProvider>
        <WebAiAccountsSection />
      </TooltipProvider>
    )
    await waitFor(() => expect(screen.getByText(/Personal browser/)).toBeInTheDocument())

    await user.click(screen.getByRole('button', { name: 'Personal ChatGPT' }))
    await waitFor(() =>
      expect(mocks.launchWebAiAccount).toHaveBeenCalledWith(account, { openNewTab: false })
    )

    await user.click(
      screen.getByRole('button', { name: 'Open another browser tab for Personal ChatGPT' })
    )
    await waitFor(() =>
      expect(mocks.launchWebAiAccount).toHaveBeenLastCalledWith(account, { openNewTab: true })
    )
  })

  it('persists the independent collapsed state', async () => {
    const user = userEvent.setup()
    render(
      <TooltipProvider>
        <WebAiAccountsSection />
      </TooltipProvider>
    )

    await user.click(screen.getByRole('button', { name: 'Toggle Web AI Accounts' }))

    expect(mocks.setWebAiAccountsCollapsed).toHaveBeenCalledWith(true)
  })

  it('refreshes profiles when opening the add dialog', async () => {
    const secondProfile: BrowserSessionProfile = {
      ...profile,
      id: 'profile-2',
      partition: 'persist:profile-2',
      label: 'Work browser'
    }
    const listProfiles = window.api.browser.sessionListProfiles as ReturnType<typeof vi.fn>
    listProfiles.mockResolvedValueOnce([profile]).mockResolvedValue([profile, secondProfile])
    const user = userEvent.setup()
    render(
      <TooltipProvider>
        <WebAiAccountsSection />
      </TooltipProvider>
    )
    await waitFor(() => expect(listProfiles).toHaveBeenCalledTimes(1))

    await user.click(screen.getByRole('button', { name: 'Add Web AI account' }))

    await waitFor(() => expect(listProfiles).toHaveBeenCalledTimes(2))
    expect(screen.getByRole('dialog')).toBeInTheDocument()
  })

  it('removes only a newly created profile when settings persistence fails', async () => {
    const createdProfile: BrowserSessionProfile = {
      id: 'profile-created',
      scope: 'isolated',
      partition: 'persist:profile-created',
      label: 'ChatGPT',
      source: null
    }
    const createProfile = window.api.browser.sessionCreateProfile as ReturnType<typeof vi.fn>
    const deleteProfile = window.api.browser.sessionDeleteProfile as ReturnType<typeof vi.fn>
    createProfile.mockResolvedValue(createdProfile)
    deleteProfile.mockResolvedValue(true)
    mocks.updateSettings.mockRejectedValueOnce(new Error('disk full'))
    const user = userEvent.setup()
    render(
      <TooltipProvider>
        <WebAiAccountsSection />
      </TooltipProvider>
    )

    await user.click(screen.getByRole('button', { name: 'Add Web AI account' }))
    await user.click(screen.getByRole('button', { name: 'Add and open' }))

    await waitFor(() =>
      expect(deleteProfile).toHaveBeenCalledWith({ profileId: createdProfile.id })
    )
    expect(mocks.launchWebAiAccount).not.toHaveBeenCalled()
  })

  it('keeps a newly created profile after account persistence when launch fails', async () => {
    const createdProfile: BrowserSessionProfile = {
      id: 'profile-created',
      scope: 'isolated',
      partition: 'persist:profile-created',
      label: 'ChatGPT',
      source: null
    }
    const createProfile = window.api.browser.sessionCreateProfile as ReturnType<typeof vi.fn>
    const deleteProfile = window.api.browser.sessionDeleteProfile as ReturnType<typeof vi.fn>
    const listProfiles = window.api.browser.sessionListProfiles as ReturnType<typeof vi.fn>
    createProfile.mockResolvedValue(createdProfile)
    listProfiles.mockResolvedValue([profile, createdProfile])
    mocks.updateSettings.mockImplementation(async (patch: Record<string, unknown>) => {
      mocks.holder.state.settings = {
        ...(mocks.holder.state.settings as Record<string, unknown>),
        ...patch
      }
    })
    mocks.launchWebAiAccount.mockImplementation(() => {
      throw new Error('launch failed')
    })
    const user = userEvent.setup()
    render(
      <TooltipProvider>
        <WebAiAccountsSection />
      </TooltipProvider>
    )

    await user.click(screen.getByRole('button', { name: 'Add Web AI account' }))
    await user.click(screen.getByRole('button', { name: 'Add and open' }))

    await waitFor(() => expect(mocks.launchWebAiAccount).toHaveBeenCalled())
    expect(deleteProfile).not.toHaveBeenCalled()
  })

  it('blocks launch when the authoritative profile list no longer matches the account', async () => {
    mocks.launchWebAiAccount.mockResolvedValueOnce({
      ok: false,
      reason: 'profile-missing',
      profiles: [{ ...profile, partition: 'persist:changed-partition' }]
    })
    const user = userEvent.setup()
    render(
      <TooltipProvider>
        <WebAiAccountsSection />
      </TooltipProvider>
    )
    await waitFor(() => expect(screen.getByText(/Personal browser/)).toBeInTheDocument())
    await user.click(screen.getByRole('button', { name: 'Personal ChatGPT' }))

    await waitFor(() =>
      expect(mocks.launchWebAiAccount).toHaveBeenCalledWith(account, {
        openNewTab: false
      })
    )
  })

  it('marks an account active only while its synthetic browser workspace is visible', async () => {
    mocks.holder.state = {
      ...mocks.holder.state,
      browserTabsByWorktree: {
        [accountWorkspaceId]: [
          {
            id: 'workspace-1',
            webAiAccountId: account.id,
            worktreeId: accountWorkspaceId,
            sessionProfileId: account.profileId,
            sessionPartition: account.sessionPartition
          },
          {
            id: 'workspace-2',
            webAiAccountId: account.id,
            worktreeId: accountWorkspaceId,
            sessionProfileId: account.profileId,
            sessionPartition: account.sessionPartition
          }
        ]
      },
      activeBrowserTabId: 'workspace-2',
      activeWorktreeId: accountWorkspaceId,
      activeTabType: 'browser',
      activeView: 'tasks'
    }
    render(
      <TooltipProvider>
        <WebAiAccountsSection />
      </TooltipProvider>
    )

    const row = await screen.findByRole('button', { name: 'Personal ChatGPT' })
    expect(row).not.toHaveAttribute('aria-current')
    expect(screen.getByText('2')).toBeInTheDocument()
  })

  it('marks an account active when any of its visible tabs is selected', async () => {
    mocks.holder.state = {
      ...mocks.holder.state,
      browserTabsByWorktree: {
        [accountWorkspaceId]: [
          {
            id: 'workspace-1',
            webAiAccountId: account.id,
            worktreeId: accountWorkspaceId,
            sessionProfileId: account.profileId,
            sessionPartition: account.sessionPartition
          },
          {
            id: 'workspace-2',
            webAiAccountId: account.id,
            worktreeId: accountWorkspaceId,
            sessionProfileId: account.profileId,
            sessionPartition: account.sessionPartition
          }
        ]
      },
      activeBrowserTabId: 'workspace-2',
      activeWorktreeId: accountWorkspaceId,
      activeTabType: 'browser',
      activeView: 'terminal'
    }
    render(
      <TooltipProvider>
        <WebAiAccountsSection />
      </TooltipProvider>
    )

    const row = await screen.findByRole('button', { name: 'Personal ChatGPT' })
    expect(row).toHaveAttribute('aria-current', 'page')
  })

  it('counts and activates account-bound tabs across ordinary worktrees', async () => {
    mocks.holder.state = {
      ...mocks.holder.state,
      browserTabsByWorktree: {
        'wt-1': [
          {
            id: 'workspace-1',
            webAiAccountId: account.id,
            worktreeId: 'wt-1',
            sessionProfileId: account.profileId,
            sessionPartition: account.sessionPartition
          }
        ],
        'wt-2': [
          {
            id: 'workspace-2',
            webAiAccountId: account.id,
            worktreeId: 'wt-2',
            sessionProfileId: account.profileId,
            sessionPartition: account.sessionPartition
          }
        ]
      },
      activeBrowserTabId: 'workspace-2',
      activeWorktreeId: 'wt-2',
      activeTabType: 'browser',
      activeView: 'terminal'
    }
    render(
      <TooltipProvider>
        <WebAiAccountsSection />
      </TooltipProvider>
    )

    const row = await screen.findByRole('button', { name: 'Personal ChatGPT' })
    expect(row).toHaveAttribute('aria-current', 'page')
    expect(screen.getByText('2')).toBeInTheDocument()
  })
})
