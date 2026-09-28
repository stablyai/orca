// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { resetSshConnectInFlightForTests } from '@/ssh/ssh-connect-in-flight'
import type { WorktreeHostConnection } from '@/lib/worktree-host-connection-phase'

const mocks = vi.hoisted(() => {
  const hostConnection: WorktreeHostConnection = {
    phase: 'unavailable',
    targetId: 'target-a',
    environmentId: null,
    publishedStatus: 'disconnected',
    connectedEpoch: null,
    unavailableReason: 'user-disconnected'
  }
  return { prepare: vi.fn(), connect: vi.fn(), ensureConnected: vi.fn(), hostConnection }
})

vi.mock('@/lib/worktree-runtime-owner', () => ({
  getExecutionHostIdForWorktree: () => 'ssh:target-a'
}))

vi.mock('@/lib/worktree-host-connection-phase', () => ({
  useWorktreeHostConnection: () => mocks.hostConnection
}))

vi.mock('../host-guest/webview-registry', () => ({
  destroyPersistentWebview: vi.fn()
}))

import { SshRoutedBrowserPageGate } from './ssh-routed-browser-page-gate'

const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })

describe("SshRoutedBrowserPageGate on a host the user's Disconnect holds down", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState(), true)
    useAppStore.setState({ sshTargetLabels: new Map([['target-a', 'devbox']]) })
    resetSshConnectInFlightForTests()
    mocks.prepare.mockReset().mockRejectedValue(new Error('browser_local_route_ssh_unavailable'))
    mocks.connect.mockReset().mockResolvedValue(null)
    mocks.ensureConnected.mockReset()
    mocks.hostConnection = { ...mocks.hostConnection, unavailableReason: 'user-disconnected' }
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        browser: { prepareSshWorkspacePartition: mocks.prepare },
        ssh: { connect: mocks.connect, ensureConnected: mocks.ensureConnected }
      }
    })
  })
  afterEach(() => cleanup())

  it("names the user's Disconnect and connects with the user's own connect", async () => {
    render(
      <SshRoutedBrowserPageGate worktreeId="wt-1" sessionProfileId={null} pageIds={['page-1']}>
        {() => <div data-testid="page" />}
      </SshRoutedBrowserPageGate>
    )
    await settle()

    expect(screen.getByText('You disconnected devbox')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    await settle()

    expect(mocks.connect).toHaveBeenCalledWith({ targetId: 'target-a' })
    expect(mocks.ensureConnected).not.toHaveBeenCalled()
  })

  it('keeps the ordinary failure card when the host is down for another reason', async () => {
    mocks.hostConnection = { ...mocks.hostConnection, unavailableReason: null }
    render(
      <SshRoutedBrowserPageGate worktreeId="wt-1" sessionProfileId={null} pageIds={['page-1']}>
        {() => <div data-testid="page" />}
      </SshRoutedBrowserPageGate>
    )
    await settle()

    expect(screen.getByText('SSH connection unavailable')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy()
  })
})
