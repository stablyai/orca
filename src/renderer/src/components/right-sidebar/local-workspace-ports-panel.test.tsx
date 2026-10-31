// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import { useAppStore } from '@/store'
import { TooltipProvider } from '@/components/ui/tooltip'
import { LocalWorkspacePortsPanel } from './local-workspace-ports-panel'
import type { WorkspaceServerLaunchList } from './workspace-server-launch-list'
import type { WorkspaceServerLaunchDialog } from './workspace-server-launch-dialog'
import type { LocalPortSection } from './local-port-section'

const fixture = vi.hoisted(() => ({
  worktree: { id: 'workspace', repoId: 'repo' },
  port: {
    id: 'port',
    port: 4008,
    bindHost: '127.0.0.1',
    connectHost: 'localhost',
    protocol: 'http' as const,
    kind: 'workspace' as const,
    owner: {
      repoId: 'repo',
      worktreeId: 'workspace',
      displayName: 'Workspace',
      path: '/workspace',
      confidence: 'cwd' as const
    }
  }
}))

vi.mock('@/store', async () => {
  const { create } = await import('zustand')
  return {
    useAppStore: create(() => ({
      settings: {},
      repos: [{ executionHostId: 'local' }],
      createBrowserTab: vi.fn(),
      setRemoteBrowserPageHandle: vi.fn(),
      workspacePortScansByKey: {
        'local:all': { platform: 'darwin', scannedAt: 1, ports: [fixture.port] }
      },
      workspacePortScanRefreshing: false,
      replaceWorkspacePortScans: vi.fn(),
      setWorkspacePortScanRefreshing: vi.fn()
    }))
  }
})
vi.mock('@/store/selectors', () => ({ useActiveWorktree: () => fixture.worktree }))
vi.mock('@/lib/worktree-runtime-owner', () => ({
  getKnownExecutionHostIdForWorktree: (s: { repos: { executionHostId: string }[] }) =>
    s.repos[0]?.executionHostId ?? null
}))
vi.mock('@/lib/workspace-server-launches', () => ({
  useWorkspaceServerLaunches: () => [
    {
      worktreeId: 'workspace',
      executionHostId: 'local',
      port: 4008,
      runtimeTarget: { kind: 'local' }
    }
  ]
}))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('@/lib/workspace-port-actions', () => ({
  workspacePortRuntimeTargetKey: () => 'local',
  killWorkspacePortForTarget: vi.fn(),
  openWorkspacePortInBrowser: vi.fn(),
  publishWorkspacePortScanForHost: vi.fn(),
  refreshWorkspacePortScanAfterStop: vi.fn(),
  resolvePortOpenInOrcaBrowser: vi.fn(),
  scanWorkspacePortsForTarget: vi.fn()
}))
vi.mock('@/lib/workspace-port-localhost-label-selector', () => ({
  resolveLocalhostLabelRouteForPort: vi.fn()
}))
vi.mock('./workspace-server-launch-list', () => ({
  WorkspaceServerLaunchList: (props: ComponentProps<typeof WorkspaceServerLaunchList>) => (
    <output aria-label="Launch host">{props.executionHostId}</output>
  )
}))
vi.mock('./workspace-server-launch-dialog', () => ({
  WorkspaceServerLaunchDialog: (props: ComponentProps<typeof WorkspaceServerLaunchDialog>) => (
    <output aria-label="Configure host">{props.executionHostId}</output>
  )
}))
vi.mock('./local-port-section', () => ({
  LocalPortSection: (props: ComponentProps<typeof LocalPortSection>) =>
    props.id === 'active' ? (
      <div>
        <output aria-label="Detected ports">{props.ports.map((p) => p.port).join(',')}</output>
        <output aria-label="Empty state">{props.emptyText}</output>
        <button onClick={() => props.onConfigureServer?.(fixture.port)}>Configure</button>
      </div>
    ) : null
}))
vi.mock('./local-port-details-dialog', () => ({ LocalPortDetailsDialog: () => null }))
vi.mock('./ssh-forwarded-ports-section', () => ({ SshForwardedPortsSection: () => null }))

afterEach(cleanup)

describe('local workspace execution-host updates', () => {
  it('updates launches, detected-port filtering and new configuration without switching workspaces', () => {
    render(
      <TooltipProvider>
        <LocalWorkspacePortsPanel isVisible runtimeTarget={{ kind: 'local' }} />
      </TooltipProvider>
    )
    expect(screen.getByLabelText('Launch host').textContent).toBe('local')
    expect(screen.getByLabelText('Detected ports').textContent).toBe('')
    expect(screen.getByLabelText('Empty state').textContent).toBe('')

    // Change only ownership; every other subscribed slice and the active workspace stay identical.
    act(() =>
      useAppStore.setState((s) => ({
        repos: s.repos.map((repo) => ({ ...repo, executionHostId: 'runtime:remote' }))
      }))
    )

    expect(screen.getByLabelText('Launch host').textContent).toBe('runtime:remote')
    expect(screen.getByLabelText('Detected ports').textContent).toBe('4008')
    expect(screen.getByLabelText('Empty state').textContent).toBe('No ports detected')
    fireEvent.click(screen.getByRole('button', { name: 'Configure' }))
    expect(screen.getByLabelText('Configure host').textContent).toBe('runtime:remote')
  })
})
