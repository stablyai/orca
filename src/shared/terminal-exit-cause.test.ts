import { describe, expect, it } from 'vitest'
import {
  isProvenProcessExit,
  resolveProcessExitCause,
  resolveUnreportedExitCause
} from './terminal-exit-cause'

describe('resolveProcessExitCause', () => {
  it('reports a signalled death as a signal, not as the zero node-pty pairs with it', () => {
    expect(resolveProcessExitCause({ exitCode: 0, signal: 9 })).toEqual({
      kind: 'signaled',
      signal: 9
    })
  })

  it('refuses to read a status the host cannot report', () => {
    // macOS login -flpq returns 0 for both exit 42 and SIGKILL.
    expect(
      resolveProcessExitCause({ exitCode: 0, signal: 0, hostReportsChildExitStatus: false })
    ).toEqual({ kind: 'unknown', reason: 'host_status_unavailable' })
    expect(
      resolveProcessExitCause({ exitCode: 42, signal: 9, hostReportsChildExitStatus: false })
    ).toEqual({ kind: 'unknown', reason: 'host_status_unavailable' })
  })

  it('treats the stop paths’ negative sentinel as absence of evidence', () => {
    expect(resolveProcessExitCause({ exitCode: -1 })).toEqual({
      kind: 'unknown',
      reason: 'stop_unverified'
    })
  })
})

describe('resolveUnreportedExitCause', () => {
  it('refuses to turn a bare zero into a clean finish', () => {
    // Older daemons/relays supply no cause; bare zero cannot distinguish a clean exit from a signal.
    expect(resolveUnreportedExitCause(0)).toEqual({ kind: 'unknown', reason: 'cause_unreported' })
  })

  it('keeps a bare nonzero status, which nothing fabricates', () => {
    // node-pty pairs signals with 0 and the wrapper returns 0, so nonzero preserves the child’s wait status.
    expect(resolveUnreportedExitCause(137)).toEqual({ kind: 'exited', exitCode: 137 })
  })
})

describe('isProvenProcessExit', () => {
  it('rejects the synthetic loss sentinel', () => {
    // A host shutdown can deliver -1 for every PTY without proving process death.
    expect(isProvenProcessExit(-1)).toBe(false)
  })

  it('keeps a shell that a user closed with `exit` tearing down on macOS', () => {
    // macOS login hides the cause but waits for the shell; its exit still proves shell death and permits teardown.
    expect(
      resolveProcessExitCause({ exitCode: 0, signal: 0, hostReportsChildExitStatus: false }).kind
    ).toBe('unknown')
    expect(isProvenProcessExit(0)).toBe(true)
  })
})
