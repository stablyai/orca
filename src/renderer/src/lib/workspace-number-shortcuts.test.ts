import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebAiAccount } from '../../../shared/types'
import {
  activateWebAiAccountNumberShortcut,
  activateWorkspaceNumberShortcut,
  resolveWebAiAccountNumberShortcutTarget,
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

  it('keeps workspace numbers scoped to visible project worktrees', () => {
    expect(resolveWorkspaceNumberShortcutTarget(['wt-a', 'wt-b'], 0)).toEqual({
      kind: 'worktree',
      worktreeId: 'wt-a'
    })
    expect(resolveWorkspaceNumberShortcutTarget(['wt-a', 'wt-b'], 1)).toEqual({
      kind: 'worktree',
      worktreeId: 'wt-b'
    })
    expect(resolveWorkspaceNumberShortcutTarget(['wt-a', 'wt-b'], 2)).toBeNull()
  })

  it('resolves Web AI accounts through a separate number range', () => {
    const chatgpt = account('chatgpt-main', 'chatgpt')
    const claude = account('claude-work', 'claude')

    expect(resolveWebAiAccountNumberShortcutTarget([chatgpt, claude], 0)).toEqual(chatgpt)
    expect(resolveWebAiAccountNumberShortcutTarget([chatgpt, claude], 1)).toEqual(claude)
    expect(resolveWebAiAccountNumberShortcutTarget([chatgpt, claude], 2)).toBeNull()
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

    await expect(activateWebAiAccountNumberShortcut(0)).resolves.toBe(true)
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

    await expect(activateWebAiAccountNumberShortcut(0)).resolves.toBe(false)
    expect(launchWebAiAccount).toHaveBeenCalledWith(chatgpt)
    expect(mocks.activateAndRevealWorktree).not.toHaveBeenCalled()
  })

  it('activates the worktree at the requested visible index', async () => {
    mocks.getState.mockReturnValue({
      settings: { webAiAccounts: [] }
    })
    mocks.getVisibleWorktreeIds.mockReturnValue(['wt-a', 'wt-b'])
    mocks.activateAndRevealWorktree.mockReturnValue({ primaryTabId: null })

    await expect(activateWorkspaceNumberShortcut(1)).resolves.toBe(true)
    expect(mocks.activateAndRevealWorktree).toHaveBeenCalledWith('wt-b')
  })

  it('collapses concurrent account launches for the same profile', async () => {
    const chatgpt = account('chatgpt-main', 'chatgpt')
    let resolveLaunch: ((value: { ok: true }) => void) | undefined
    const launchWebAiAccount = vi.fn(
      () =>
        new Promise<{ ok: true }>((resolve) => {
          resolveLaunch = resolve
        })
    )
    mocks.getState.mockReturnValue({
      settings: { webAiAccounts: [chatgpt] },
      launchWebAiAccount
    })

    const first = activateWebAiAccountNumberShortcut(0)
    await expect(activateWebAiAccountNumberShortcut(0)).resolves.toBe(false)
    expect(launchWebAiAccount).toHaveBeenCalledTimes(1)
    resolveLaunch?.({ ok: true })
    await expect(first).resolves.toBe(true)
  })

  it('does nothing when the requested number is out of range', async () => {
    mocks.getState.mockReturnValue({
      settings: { webAiAccounts: [] }
    })
    mocks.getVisibleWorktreeIds.mockReturnValue(['wt-a'])

    await expect(activateWorkspaceNumberShortcut(4)).resolves.toBe(false)
    expect(mocks.activateAndRevealWorktree).not.toHaveBeenCalled()
  })
})
