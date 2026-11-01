// @vitest-environment happy-dom
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { WslHostConnectionState } from '../../../../shared/wsl-host-types'
import type { PtyTransport } from './pty-transport-types'
import { useRetryPanesWhenWslHostReturns } from './use-wsl-host-return-retry'

function pane(environmentId: string | null, retrying = true): PtyTransport {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hook reads only these three members.
  return {
    getRuntimeEnvironmentId: () => environmentId,
    retryRecovery: vi.fn(() => retrying),
    reopenAfterHostReturned: vi.fn(() => true)
  } as unknown as PtyTransport
}

let status: WslHostConnectionState | undefined

function hostStatus(state: WslHostConnectionState): void {
  status = state
}

afterEach(() => {
  cleanup()
  status = undefined
})

describe('a stopped WSL host coming back on its own', () => {
  it("retries the host's panes once it is ready again, and only those", () => {
    hostStatus('ready')
    const hostPane = pane('wsl:ubuntu')
    // A pane whose create failed before it reached the host has no server yet: still the host's.
    const unboundPane = pane(null)
    const otherPane = pane('ssh:desk')
    const transports = {
      current: new Map([
        [1, hostPane],
        [2, unboundPane],
        [3, otherPane]
      ])
    }
    const { rerender } = renderHook(() =>
      useRetryPanesWhenWslHostReturns('wsl:ubuntu', status, transports)
    )
    expect(hostPane.retryRecovery).not.toHaveBeenCalled()

    for (const state of ['distro-stopped', 'connecting', 'ready'] as const) {
      hostStatus(state)
      rerender()
    }
    expect(hostPane.retryRecovery).toHaveBeenCalledOnce()
    expect(unboundPane.retryRecovery).toHaveBeenCalledOnce()
    expect(otherPane.retryRecovery).not.toHaveBeenCalled()

    // Ready again with no stop between leaves healthy panes alone.
    hostStatus('connecting')
    rerender()
    hostStatus('ready')
    rerender()
    expect(hostPane.retryRecovery).toHaveBeenCalledOnce()
  })

  it('counts a stop already showing when the pane mounts', () => {
    hostStatus('distro-stopped')
    const hostPane = pane('wsl:ubuntu')
    const { rerender } = renderHook(() =>
      useRetryPanesWhenWslHostReturns('wsl:ubuntu', status, { current: new Map([[1, hostPane]]) })
    )
    hostStatus('ready')
    rerender()
    expect(hostPane.retryRecovery).toHaveBeenCalledOnce()
  })

  // Why: after a relaunch the restored pane's connect was refused, so no retry is armed to resume.
  it('reopens a pane the stop left idle, and clears the stop’s error, after Start', () => {
    hostStatus('distro-stopped')
    const idlePane = pane('wsl:ubuntu', false)
    const retryingPane = pane('wsl:ubuntu', true)
    const onHostReturned = vi.fn()
    const { rerender } = renderHook(() =>
      useRetryPanesWhenWslHostReturns(
        'wsl:ubuntu',
        status,
        {
          current: new Map([
            [1, idlePane],
            [2, retryingPane]
          ])
        },
        onHostReturned
      )
    )
    expect(onHostReturned).not.toHaveBeenCalled()
    hostStatus('ready')
    rerender()
    expect(onHostReturned).toHaveBeenCalledOnce()
    expect(idlePane.reopenAfterHostReturned).toHaveBeenCalledOnce()
    // A pane whose own retry took over is not opened a second time.
    expect(retryingPane.reopenAfterHostReturned).not.toHaveBeenCalled()
  })
})
