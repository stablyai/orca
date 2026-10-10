// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorktreeRuntimeOwnerState } from '@/lib/worktree-runtime-owner'
import { createGlobalSettingsFixture } from '../../../../shared/global-settings-test-fixture'
import { AgentLaunchSettingsSection } from './AgentLaunchSettingsSection'

const state = vi.hoisted(() => {
  const workspace: WorktreeRuntimeOwnerState = {}
  return {
    workspace,
    runtimeEnvironments: [{ id: 'ssh-host', name: 'SSH host', createdAt: 1, pairingRevision: 17 }],
    remote: vi.fn(),
    local: vi.fn()
  }
})
vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (
      selector: (
        value: typeof state.workspace & { runtimeEnvironments: typeof state.runtimeEnvironments }
      ) => unknown
    ) => selector({ ...state.workspace, runtimeEnvironments: state.runtimeEnvironments }),
    { getState: () => ({ settings: null }) }
  )
}))
vi.mock('../sidebar/use-sidebar-host-scope-options', () => ({
  useSidebarHostScopeOptions: () => ({
    hostOptions: [
      { id: 'local', label: 'Local', kind: 'local', health: 'local', presence: 'local' },
      {
        id: 'runtime:ssh-host',
        label: 'SSH host',
        kind: 'runtime',
        health: 'available',
        presence: 'configured',
        aliasHostIds: ['ssh:old-ssh']
      }
    ]
  })
}))
vi.mock('./HostAgentLaunchSettings', async () => {
  const { useState } = await import('react')
  return {
    HostAgentLaunchSettings: (props: { environmentId: string; pairingRevision: number }) => {
      state.remote(props)
      // Stands in for unsaved edits: survives prop changes, dropped only by a remount.
      const [mountedAt] = useState(props.pairingRevision)
      return <p>Remote launch settings mounted at {mountedAt}</p>
    }
  }
})
vi.mock('./AgentLaunchSettingsCatalog', () => ({
  AgentLaunchSettingsCatalog: (props: unknown) => {
    state.local(props)
    return <p>Local launch settings</p>
  }
}))
afterEach(cleanup)
beforeEach(() => {
  state.workspace = {}
  state.runtimeEnvironments = [
    { id: 'ssh-host', name: 'SSH host', createdAt: 1, pairingRevision: 17 }
  ]
  state.remote.mockClear()
  state.local.mockClear()
})
const renderSection = (activeRuntimeEnvironmentId: string | null = null) =>
  render(
    <AgentLaunchSettingsSection
      settings={createGlobalSettingsFixture({ activeRuntimeEnvironmentId })}
      updateSettings={vi.fn()}
      renderPermissions={() => null}
    />
  )

describe('launch settings host selection', () => {
  it('targets the SSH workspace host when the global default is Local', () => {
    state.workspace = {
      activeWorktreeId: 'repo::wt',
      worktreesByRepo: { repo: [{ id: 'repo::wt', repoId: 'repo', hostId: 'runtime:ssh-host' }] }
    }
    renderSection()
    expect(screen.getByText('Remote launch settings mounted at 17')).toBeTruthy()
    expect(state.remote.mock.calls[0]?.[0]).toMatchObject({
      environmentId: 'ssh-host',
      pairingRevision: 17,
      hostName: 'SSH host'
    })
    expect(state.local).not.toHaveBeenCalled()
  })

  it('uses the same authority rule for folder workspaces', () => {
    state.workspace = {
      activeWorktreeId: 'folder:work',
      folderWorkspaces: [
        { id: 'work', projectGroupId: 'group', executionHostId: 'runtime:ssh-host' }
      ]
    }
    renderSection()
    expect(state.remote.mock.calls[0]?.[0].environmentId).toBe('ssh-host')
    expect(state.local).not.toHaveBeenCalled()
  })

  it('resolves a managed SSH alias to its runtime without another host row', () => {
    state.workspace = {
      activeWorktreeId: 'repo::wt',
      worktreesByRepo: { repo: [{ id: 'repo::wt', repoId: 'repo', hostId: 'ssh:old-ssh' }] }
    }
    renderSection()
    expect(state.remote.mock.calls[0]?.[0].environmentId).toBe('ssh-host')
    expect(screen.getByRole('combobox').textContent).toContain('SSH host')
  })

  it('opens on the Active Server without an active workspace', () => {
    renderSection(' ssh-host ')
    expect(state.remote.mock.calls[0]?.[0].environmentId).toBe('ssh-host')
    expect(state.local).not.toHaveBeenCalled()
  })

  it('remounts the host form when its host is re-paired, dropping unsaved edits', () => {
    const { rerender } = renderSection(' ssh-host ')
    expect(screen.getByText('Remote launch settings mounted at 17')).toBeTruthy()
    state.runtimeEnvironments = [
      { id: 'ssh-host', name: 'SSH host', createdAt: 1, pairingRevision: 18 }
    ]
    rerender(
      <AgentLaunchSettingsSection
        settings={createGlobalSettingsFixture({ activeRuntimeEnvironmentId: ' ssh-host ' })}
        updateSettings={vi.fn()}
        renderPermissions={() => null}
      />
    )
    expect(screen.getByText('Remote launch settings mounted at 18')).toBeTruthy()
  })

  it('keeps unknown workspace ownership unresolved instead of displaying desktop defaults', () => {
    state.workspace = { activeWorktreeId: 'repo::missing' }
    renderSection()
    expect(screen.getByText('Loading agent settings…')).toBeTruthy()
    expect(state.local).not.toHaveBeenCalled()
    expect(state.remote).not.toHaveBeenCalled()
  })
})
