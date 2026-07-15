import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebAiAccount } from '../../../shared/types'
import {
  activateWorkspaceNumberShortcut,
  resolveWorkspaceNumberShortcutTarget
} from './workspace-number-shortcuts'

const mocks = vi.hoisted(() => ({
  activateAndRevealWorktree: vi.fn(),
  getState: vi.fn(),
  getVisibleWorktreeIds: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: { getState: mocks.getState }
}))

vi.mock('@/components/sidebar/visible-worktrees', () => ({
  getVisibleWorktreeIds: mocks.getVisibleWorktreeIds
}))

vi.mock('./worktree-activation', () => ({
  activateAndRevealWorktree: mocks.activateAndRevealWorktree
}))

function account(id: string, provider: WebAiAccount['provider']): WebAiAccount {
  return {
    id,
    provider,
    label: id,
    executionHostId: 'local',
    profileId: `profile-${id}`,
    sessionPartition: `persist:${id}`,
    createdAt: 1
  }
}

describe('workspace number shortcuts', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('places Web AI accounts before visible project workspaces', () => {
    const chatgpt = account('chatgpt-main', 'chatgpt')
    const claude = account('claude-work', 'claude')

    expect(resolveWorkspaceNumberShortcutTarget([chatgpt, claude], ['wt-a', 'wt-b'], 0)).toEqual({
      kind: 'web-ai-account',
      account: chatgpt
    })
    expect(resolveWorkspaceNumberShortcutTarget([chatgpt, claude], ['wt-a', 'wt-b'], 1)).toEqual({
      kind: 'web-ai-account',
      account: claude
    })
    expect(resolveWorkspaceNumberShortcutTarget([chatgpt, claude], ['wt-a', 'wt-b'], 2)).toEqual({
      kind: 'worktree',
      worktreeId: 'wt-a'
    })
  })

  it('opens the selected account through authoritative profile validation', async () => {
    const chatgpt = account('chatgpt-main', 'chatgpt')
    const launchWebAiAccount = vi.fn(async () => ({
      ok: true as const,
      workspace: { id: 'browser-workspace' },
      profiles: []
    }))
    mocks.getState.mockReturnValue({
      settings: { webAiAccounts: [chatgpt] },
      launchWebAiAccount
    })
    mocks.getVisibleWorktreeIds.mockReturnValue(['wt-a'])

    await expect(activateWorkspaceNumberShortcut(0)).resolves.toBe(true)
    expect(launchWebAiAccount).toHaveBeenCalledWith(chatgpt)
    expect(mocks.activateAndRevealWorktree).not.toHaveBeenCalled()
  })

  it('does not open an account whose profile validation fails', async () => {
    const chatgpt = account('chatgpt-main', 'chatgpt')
    const launchWebAiAccount = vi.fn(async () => ({
      ok: false as const,
      reason: 'profile-missing' as const,
      profiles: []
    }))
    mocks.getState.mockReturnValue({
      settings: { webAiAccounts: [chatgpt] },
      launchWebAiAccount
    })
    mocks.getVisibleWorktreeIds.mockReturnValue(['wt-a'])

    await expect(activateWorkspaceNumberShortcut(0)).resolves.toBe(false)
    expect(launchWebAiAccount).toHaveBeenCalledWith(chatgpt)
    expect(mocks.activateAndRevealWorktree).not.toHaveBeenCalled()
  })

  it('offsets project workspace activation by the account count', async () => {
    const chatgpt = account('chatgpt-main', 'chatgpt')
    mocks.getState.mockReturnValue({
      settings: { webAiAccounts: [chatgpt] },
      launchWebAiAccount: vi.fn()
    })
    mocks.getVisibleWorktreeIds.mockReturnValue(['wt-a', 'wt-b'])
    mocks.activateAndRevealWorktree.mockReturnValue({ primaryTabId: null })

    await expect(activateWorkspaceNumberShortcut(2)).resolves.toBe(true)
    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith('wt-b')
  })

  it('does nothing when the requested number is out of range', async () => {
    const launchWebAiAccount = vi.fn()
    mocks.getState.mockReturnValue({
      settings: { webAiAccounts: [] },
      launchWebAiAccount
    })
    mocks.getVisibleWorktreeIds.mockReturnValue(['wt-a'])

    await expect(activateWorkspaceNumberShortcut(4)).resolves.toBe(false)
    expect(launchWebAiAccount).not.toHaveBeenCalled()
    expect(mocks.activateAndRevealWorktree).not.toHaveBeenCalled()
  })
})
