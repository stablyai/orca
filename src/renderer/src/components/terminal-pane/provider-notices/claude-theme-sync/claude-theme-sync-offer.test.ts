// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const toast = vi.hoisted(() => Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast }))
vi.mock('@/app-shell/chrome/desktop-window-chrome', () => ({ isPairedWebClientWindow: () => false }))

import { useAppStore } from '@/store/index'
import { seedCloudWorkspaceSnapshot } from '@/lib/orca-cloud/orca-cloud-workspace-store'
import { useClaudeThemeSyncOffer } from './claude-theme-sync-offer'
import { getDefaultSettings } from '../../../../../../shared/constants'
import { makeTerminalTab } from '../../../worktree-jump/worktree-jump-palette-test-fixtures'

const initial = useAppStore.getState()

type State = ReturnType<typeof useAppStore.getState>

function seed(active: { id: string; host: State['activeWorkspaceExecutionHostId'] }): void {
  const settings = initial.settings ?? getDefaultSettings('/home/test')
  useAppStore.setState({
    settings: { ...settings, claudeCodeThemeSyncOffer: 'pending' },
    updateSettings: vi.fn<State['updateSettings']>(async () => undefined),
    activeWorktreeId: active.id,
    activeWorkspaceExecutionHostId: active.host,
    activePendingCreationId: null,
    tabsByWorktree: {
      [active.id]: [{ ...makeTerminalTab('tab-1', active.id, 'Claude'), launchAgent: 'claude' }]
    }
  })
}

beforeEach(() => toast.mockClear())
afterEach(() => {
  cleanup()
  seedCloudWorkspaceSnapshot({})
  useAppStore.setState(initial, true)
})

describe('Claude Code theme-sync offer (RA-6)', () => {
  it('holds the offer while Claude runs in an Orca Cloud workspace, then makes it on a local one', () => {
    seedCloudWorkspaceSnapshot({ ids: new Set(['cloud-ws']), idsLoaded: true })
    seed({ id: 'cloud-ws', host: 'runtime:env-a' })
    renderHook(() => useClaudeThemeSyncOffer())
    expect(toast).not.toHaveBeenCalled()

    act(() => {
      useAppStore.setState({
        activeWorktreeId: 'local-ws',
        activeWorkspaceExecutionHostId: 'local'
      })
    })
    expect(toast).toHaveBeenCalledTimes(1)
    expect(toast.mock.calls[0]?.[0]).toBe('Match Claude Code to your Orca theme?')
  })

  it('holds it for a brand-new cloud workspace that is not in the cloud id list yet', () => {
    seedCloudWorkspaceSnapshot({ ids: new Set(), idsLoaded: true })
    seed({ id: 'new-cloud-ws', host: 'runtime:env-b' })
    renderHook(() => useClaudeThemeSyncOffer())
    expect(toast).not.toHaveBeenCalled()
  })

  it('offers right away when Claude runs on this computer', () => {
    seedCloudWorkspaceSnapshot({ ids: new Set(), idsLoaded: true })
    seed({ id: 'local-ws', host: 'local' })
    renderHook(() => useClaudeThemeSyncOffer())
    expect(toast).toHaveBeenCalledTimes(1)
  })
})
