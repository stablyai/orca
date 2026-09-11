import { describe, expect, it } from 'vitest'
import { LOCAL_PTY_STARTUP_FAIL_OPEN_TIMEOUT_MS } from '../../../../../main/startup/first-window-startup-services'
import {
  CONNECTION_ATTEMPT_WAIT_MS,
  REQUEST_TIMEOUT_MS
} from '../../../../../main/daemon/rpc-timeouts'
import {
  REMOTE_RUNTIME_SPAWN_SETTLEMENT_WATCHDOG_MS,
  SPAWN_SETTLEMENT_WATCHDOG_MS
} from './pty-connect-limits'
import { REMOTE_RUNTIME_AUTO_RECOVERY_TIMEOUT_MS } from '../remote-runtime-pty-recovery-state'

// Why a parity test: the watchdog mirrors main's spawn budgets by value, because a
// renderer module cannot import them. If main's gate grows past this deadline the
// watchdog starts remounting spawns that were about to succeed, which is silent —
// the pane just respawns. Fail here instead.
describe('spawn settlement watchdog budget', () => {
  // Sequential, not overlapping: pty:spawn awaits the startup gate, and only then
  // does the daemon client spend its connection-attempt wait plus one request timeout.
  const worstLegitimateLocalSettleMs =
    LOCAL_PTY_STARTUP_FAIL_OPEN_TIMEOUT_MS + CONNECTION_ATTEMPT_WAIT_MS + REQUEST_TIMEOUT_MS

  it('outlasts the slowest settle a local cold start can legitimately take', () => {
    expect(SPAWN_SETTLEMENT_WATCHDOG_MS).toBeGreaterThan(worstLegitimateLocalSettleMs)
  })

  it('keeps real headroom over that worst case rather than racing it', () => {
    expect(SPAWN_SETTLEMENT_WATCHDOG_MS - worstLegitimateLocalSettleMs).toBeGreaterThanOrEqual(
      REQUEST_TIMEOUT_MS
    )
  })

  // A remote-runtime create arms this ladder on its first recoverable connection error
  // and keeps retrying inside the create call, so the connect promise legitimately
  // pends that long. Timing out under it remounts a pane whose create is still running.
  it('outlasts the remote-runtime create ladder for a remote pane', () => {
    expect(REMOTE_RUNTIME_SPAWN_SETTLEMENT_WATCHDOG_MS).toBeGreaterThan(
      REMOTE_RUNTIME_AUTO_RECOVERY_TIMEOUT_MS
    )
  })

  it('does not make a local pane wait on the remote ladder', () => {
    expect(SPAWN_SETTLEMENT_WATCHDOG_MS).toBeLessThan(REMOTE_RUNTIME_SPAWN_SETTLEMENT_WATCHDOG_MS)
  })
})
