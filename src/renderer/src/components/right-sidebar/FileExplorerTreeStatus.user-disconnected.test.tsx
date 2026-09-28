// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { resetSshConnectInFlightForTests } from '@/ssh/ssh-connect-in-flight'
import type { WorktreeHostConnection } from '@/lib/worktree-host-connection-phase'

const READ_ERROR =
  "Error invoking remote method 'fs:readDir': Error: Remote connection dropped. Click Reconnect on the SSH target before retrying."

const mocks = vi.hoisted(() => {
  const host: { connection: WorktreeHostConnection | null } = { connection: null }
  return { connect: vi.fn(), ensureConnected: vi.fn(), host }
})

vi.mock('@/lib/worktree-host-connection-phase', () => ({
  useWorktreeHostConnection: () => mocks.host.connection
}))

import { FileExplorerTreeStatus } from './FileExplorerTreeStatus'

function hostConnecting() {
  mocks.host.connection = {
    phase: 'connecting',
    targetId: 'ssh-a',
    environmentId: null,
    publishedStatus: 'connecting',
    connectedEpoch: null,
    unavailableReason: null
  }
}

function hostDown(unavailableReason: WorktreeHostConnection['unavailableReason']) {
  mocks.host.connection = {
    phase: 'unavailable',
    targetId: 'ssh-a',
    environmentId: null,
    publishedStatus: 'disconnected',
    connectedEpoch: null,
    unavailableReason
  }
}

function renderStatus() {
  render(
    <FileExplorerTreeStatus worktreeId="wt-ssh" isLoading={false} error={READ_ERROR} isEmpty />
  )
}

describe('FileExplorerTreeStatus on an SSH host that is down', () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState(), true)
    useAppStore.setState({ sshTargetLabels: new Map([['ssh-a', 'devbox']]) })
    resetSshConnectInFlightForTests()
    mocks.connect.mockReset().mockResolvedValue(null)
    mocks.ensureConnected.mockReset()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { ssh: { connect: mocks.connect, ensureConnected: mocks.ensureConnected } }
    })
  })
  afterEach(cleanup)

  it("offers the user's own Connect in place of the raw read error", async () => {
    hostDown('user-disconnected')
    renderStatus()

    screen.getByText('You disconnected devbox')
    expect(screen.queryByText(READ_ERROR, { exact: false })).toBeNull()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    })

    expect(mocks.connect).toHaveBeenCalledWith({ targetId: 'ssh-a' })
    expect(mocks.ensureConnected).not.toHaveBeenCalled()
  })

  it('does not bring the read error back while the Connect is under way', () => {
    hostConnecting()
    renderStatus()

    expect(screen.queryByText(READ_ERROR, { exact: false })).toBeNull()
    expect(screen.queryByText('You disconnected devbox')).toBeNull()
  })

  it('keeps the read error for a host that dropped on its own', () => {
    hostDown(null)
    renderStatus()

    screen.getByText(READ_ERROR, { exact: false })
    expect(screen.queryByText('You disconnected devbox')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Connect' })).toBeNull()
  })
})
