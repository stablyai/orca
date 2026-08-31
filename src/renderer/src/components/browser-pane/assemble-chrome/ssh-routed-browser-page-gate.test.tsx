// @vitest-environment happy-dom
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'

const mocks = vi.hoisted(() => ({
  executionHostId: 'local' as string,
  prepare: vi.fn(),
  destroyPersistentWebview: vi.fn()
}))

vi.mock('@/lib/worktree-runtime-owner', () => ({
  getExecutionHostIdForWorktree: () => mocks.executionHostId
}))

vi.mock('../host-guest/webview-registry', () => ({
  destroyPersistentWebview: mocks.destroyPersistentWebview
}))

import { SshRoutedBrowserPageGate } from './ssh-routed-browser-page-gate'

const PAGE_IDS = ['page-1', 'page-2'] as const

const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })

describe('SshRoutedBrowserPageGate', () => {
  beforeEach(() => {
    mocks.prepare.mockReset()
    mocks.destroyPersistentWebview.mockReset()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { browser: { prepareSshWorkspacePartition: mocks.prepare } }
    })
  })
  afterEach(() => cleanup())

  it('renders children with no override for non-SSH workspaces without any prepare call', async () => {
    mocks.executionHostId = 'local'
    render(
      <SshRoutedBrowserPageGate worktreeId="wt-1" sessionProfileId={null} pageIds={PAGE_IDS}>
        {(partition) => <div data-testid="page">{String(partition)}</div>}
      </SshRoutedBrowserPageGate>
    )
    await settle()
    expect(screen.getByTestId('page').textContent).toBe('null')
    expect(mocks.prepare).not.toHaveBeenCalled()
  })

  it('mounts the page only on the prepared partition for SSH workspaces', async () => {
    mocks.executionHostId = 'ssh:target-a'
    mocks.prepare.mockResolvedValue({ partition: 'persist:orca-browser-v1-routed' })
    render(
      <SshRoutedBrowserPageGate worktreeId="wt-1" sessionProfileId="session-x" pageIds={PAGE_IDS}>
        {(partition) => <div data-testid="page">{String(partition)}</div>}
      </SshRoutedBrowserPageGate>
    )
    // Why: fail closed — no webview may exist before the proxy-verified partition arrives.
    expect(screen.queryByTestId('page')).toBeNull()
    await settle()
    expect(screen.getByTestId('page').textContent).toBe('persist:orca-browser-v1-routed')
    expect(mocks.prepare).toHaveBeenCalledWith({
      targetId: 'target-a',
      browserProfileId: 'session-x'
    })
  })

  it('never renders the page on failure and retries on demand', async () => {
    mocks.executionHostId = 'ssh:target-a'
    mocks.prepare.mockRejectedValueOnce(new Error('browser_tunnel_execution_host_unavailable'))
    mocks.prepare.mockResolvedValueOnce({ partition: 'persist:orca-browser-v1-routed' })
    render(
      <SshRoutedBrowserPageGate worktreeId="wt-1" sessionProfileId={null} pageIds={PAGE_IDS}>
        {(partition) => <div data-testid="page">{String(partition)}</div>}
      </SshRoutedBrowserPageGate>
    )
    await settle()
    expect(screen.queryByTestId('page')).toBeNull()
    screen.getByRole('button', { name: 'Retry' }).click()
    await settle()
    expect(screen.getByTestId('page').textContent).toBe('persist:orca-browser-v1-routed')
  })

  it('stays unrouted when the setting is off', async () => {
    mocks.executionHostId = 'ssh:target-a'
    const priorSettings = useAppStore.getState().settings
    useAppStore.setState({
      settings: { ...priorSettings, browserSshWorkspaceRoutingEnabled: false }
    } as Parameters<typeof useAppStore.setState>[0])
    try {
      render(
        <SshRoutedBrowserPageGate worktreeId="wt-1" sessionProfileId={null} pageIds={PAGE_IDS}>
          {(partition) => <div data-testid="page">{String(partition)}</div>}
        </SshRoutedBrowserPageGate>
      )
      await settle()
      expect(screen.getByTestId('page').textContent).toBe('null')
      expect(mocks.prepare).not.toHaveBeenCalled()
    } finally {
      useAppStore.setState({ settings: priorSettings } as Parameters<
        typeof useAppStore.setState
      >[0])
    }
  })

  it('offers Try anyway for a blocked-forwarding verdict and skips the probe on it', async () => {
    mocks.executionHostId = 'ssh:target-a'
    mocks.prepare.mockRejectedValueOnce(new Error('browser_local_route_forwarding_blocked'))
    mocks.prepare.mockResolvedValueOnce({ partition: 'persist:orca-browser-v1-routed' })
    render(
      <SshRoutedBrowserPageGate worktreeId="wt-1" sessionProfileId={null} pageIds={PAGE_IDS}>
        {(partition) => <div data-testid="page">{String(partition)}</div>}
      </SshRoutedBrowserPageGate>
    )
    await settle()
    expect(screen.getByText('The SSH server blocks browser traffic')).toBeTruthy()
    screen.getByRole('button', { name: 'Try anyway' }).click()
    await settle()
    expect(mocks.prepare).toHaveBeenLastCalledWith({
      targetId: 'target-a',
      browserProfileId: 'default',
      skipProbe: true
    })
    expect(screen.getByTestId('page').textContent).toBe('persist:orca-browser-v1-routed')
  })

  it('records the per-target opt-out from Browse from this device instead', async () => {
    mocks.executionHostId = 'ssh:target-a'
    mocks.prepare.mockRejectedValue(new Error('browser_local_route_ssh_unavailable'))
    const updateSettings = vi.fn()
    const prior = useAppStore.getState().updateSettings
    useAppStore.setState({ updateSettings } as unknown as Parameters<
      typeof useAppStore.setState
    >[0])
    try {
      render(
        <SshRoutedBrowserPageGate worktreeId="wt-1" sessionProfileId={null} pageIds={PAGE_IDS}>
          {(partition) => <div data-testid="page">{String(partition)}</div>}
        </SshRoutedBrowserPageGate>
      )
      await settle()
      screen.getByRole('button', { name: 'Browse from this device instead' }).click()
      expect(updateSettings).toHaveBeenCalledWith({
        browserSshWorkspaceRoutingDisabledTargetIds: ['target-a']
      })
    } finally {
      useAppStore.setState({ updateSettings: prior } as unknown as Parameters<
        typeof useAppStore.setState
      >[0])
    }
  })

  it('mounts unrouted for a target the user opted out of', async () => {
    mocks.executionHostId = 'ssh:target-a'
    const priorSettings = useAppStore.getState().settings
    useAppStore.setState({
      settings: { ...priorSettings, browserSshWorkspaceRoutingDisabledTargetIds: ['target-a'] }
    } as Parameters<typeof useAppStore.setState>[0])
    try {
      render(
        <SshRoutedBrowserPageGate worktreeId="wt-1" sessionProfileId={null} pageIds={PAGE_IDS}>
          {(partition) => <div data-testid="page">{String(partition)}</div>}
        </SshRoutedBrowserPageGate>
      )
      await settle()
      expect(screen.getByTestId('page').textContent).toBe('null')
      expect(mocks.prepare).not.toHaveBeenCalled()
    } finally {
      useAppStore.setState({ settings: priorSettings } as Parameters<
        typeof useAppStore.setState
      >[0])
    }
  })

  it('unmounts unrouted pages in the SAME render a target appears, and destroys their guests', async () => {
    // Why (review P1-1): the routed decision lags state by one commit on an
    // already-mounted instance; a stale 'unrouted' render would mount a
    // local-egress webview behind the preparing card, and unmount only parks it.
    mocks.executionHostId = 'local'
    mocks.prepare.mockResolvedValue({ partition: 'persist:orca-browser-v1-routed' })
    const view = render(
      <SshRoutedBrowserPageGate worktreeId="wt-1" sessionProfileId={null} pageIds={PAGE_IDS}>
        {(partition) => <div data-testid="page">{String(partition)}</div>}
      </SshRoutedBrowserPageGate>
    )
    await settle()
    expect(screen.getByTestId('page').textContent).toBe('null')

    mocks.executionHostId = 'ssh:target-a'
    act(() => {
      view.rerender(
        <SshRoutedBrowserPageGate worktreeId="wt-1" sessionProfileId={null} pageIds={PAGE_IDS}>
          {(partition) => <div data-testid="page">{String(partition)}</div>}
        </SshRoutedBrowserPageGate>
      )
    })
    // The transition commit itself must not render the unrouted children.
    expect(screen.queryByTestId('page')).toBeNull()
    expect(mocks.destroyPersistentWebview).toHaveBeenCalledWith('page-1')
    expect(mocks.destroyPersistentWebview).toHaveBeenCalledWith('page-2')
    await settle()
    expect(screen.getByTestId('page').textContent).toBe('persist:orca-browser-v1-routed')
  })

  it('leaves runtime-owned ephemeral SSH targets to the paired machinery', async () => {
    mocks.executionHostId = 'ssh:runtime-ssh-ephemeral-1'
    render(
      <SshRoutedBrowserPageGate worktreeId="wt-1" sessionProfileId={null} pageIds={PAGE_IDS}>
        {(partition) => <div data-testid="page">{String(partition)}</div>}
      </SshRoutedBrowserPageGate>
    )
    await settle()
    expect(screen.getByTestId('page').textContent).toBe('null')
    expect(mocks.prepare).not.toHaveBeenCalled()
  })
})
