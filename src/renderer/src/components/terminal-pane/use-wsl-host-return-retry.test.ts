// @vitest-environment happy-dom
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { WslHostConnectionState } from '../../../../shared/wsl-host-types'
import type { PtyTransport } from './pty-transport-types'
import { useRetryPanesWhenWslHostReturns } from './use-wsl-host-return-retry'

function pane(environmentId: string | null): PtyTransport {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hook reads only these two members.
  return {
    getRuntimeEnvironmentId: () => environmentId,
    retryRecovery: vi.fn(() => true)
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
})
