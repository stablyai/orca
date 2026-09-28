// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { resetSshConnectInFlightForTests } from '@/ssh/ssh-connect-in-flight'
import type { WorktreeHostConnection } from '@/lib/worktree-host-connection-phase'

const USER_DISCONNECTED_HOST: WorktreeHostConnection = {
  phase: 'unavailable',
  targetId: 'ssh-a',
  environmentId: null,
  publishedStatus: 'disconnected',
  connectedEpoch: null,
  unavailableReason: 'user-disconnected'
}

const mocks = vi.hoisted(() => {
  const host: { connection: WorktreeHostConnection | null } = { connection: null }
  return { connect: vi.fn(), ensureConnected: vi.fn(), host }
})

vi.mock('@/lib/worktree-host-connection-phase', () => ({
  useWorktreeHostConnection: () => mocks.host.connection
}))

import { EditorFileLoadErrorView } from './EditorFileLoadErrorView'
import { WORKTREE_OWNER_NOT_READY_ERROR } from './editor-panel-content-types'

describe("EditorFileLoadErrorView on a host the user's Disconnect holds down", () => {
  beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState(), true)
    useAppStore.setState({ sshTargetLabels: new Map([['ssh-a', 'devbox']]) })
    resetSshConnectInFlightForTests()
    mocks.host.connection = USER_DISCONNECTED_HOST
    mocks.connect.mockReset().mockResolvedValue(null)
    mocks.ensureConnected.mockReset()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { ssh: { connect: mocks.connect, ensureConnected: mocks.ensureConnected } }
    })
  })
  afterEach(cleanup)

  it("offers the user's own Connect in place of Retry", async () => {
    const onRetry = vi.fn()
    const { container } = render(
      <EditorFileLoadErrorView message="read failed" worktreeId="wt-ssh" onRetry={onRetry} />
    )

    screen.getByText('You disconnected devbox')
    screen.getByText('Connect it to load this file.')
    // Why: the user's own Disconnect is not a load failure, so the card must not read as one.
    expect(screen.queryByText('Unable to load file')).toBeNull()
    expect(container.querySelector('.text-destructive')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Connect' }))
    })

    expect(mocks.connect).toHaveBeenCalledWith({ targetId: 'ssh-a' })
    expect(mocks.ensureConnected).not.toHaveBeenCalled()
    expect(onRetry).not.toHaveBeenCalled()
  })

  it('shows the connecting state, not the dropped read error, once the user connects', () => {
    mocks.host.connection = {
      ...USER_DISCONNECTED_HOST,
      phase: 'connecting',
      publishedStatus: 'connecting',
      unavailableReason: null
    }
    render(
      <EditorFileLoadErrorView
        message="SSH connection is not available"
        worktreeId="wt-ssh"
        reloadsWhenHostConnects
        onRetry={vi.fn()}
      />
    )

    screen.getByText(WORKTREE_OWNER_NOT_READY_ERROR)
    expect(screen.queryByText('SSH connection is not available')).toBeNull()
  })

  it('keeps a failure the connection cannot fix while the host connects', () => {
    mocks.host.connection = {
      ...USER_DISCONNECTED_HOST,
      phase: 'connecting',
      publishedStatus: 'connecting',
      unavailableReason: null
    }
    render(
      <EditorFileLoadErrorView
        message="ENOENT: no such file or directory"
        worktreeId="wt-ssh"
        reloadsWhenHostConnects
        onRetry={vi.fn()}
      />
    )

    screen.getByText('ENOENT: no such file or directory')
    expect(screen.queryByText(WORKTREE_OWNER_NOT_READY_ERROR)).toBeNull()
  })

  it('keeps the read error on a file the retry gate does not reload, such as a conflict row', () => {
    mocks.host.connection = {
      ...USER_DISCONNECTED_HOST,
      phase: 'connecting',
      publishedStatus: 'connecting',
      unavailableReason: null
    }
    render(
      <EditorFileLoadErrorView
        message="SSH connection is not available"
        worktreeId="wt-ssh"
        onRetry={vi.fn()}
      />
    )

    screen.getByText('SSH connection is not available')
    expect(screen.queryByText(WORKTREE_OWNER_NOT_READY_ERROR)).toBeNull()
  })
})
