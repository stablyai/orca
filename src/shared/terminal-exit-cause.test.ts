import { describe, expect, it } from 'vitest'
import {
  describeTerminalExitCause,
  isDeliberateTerminalExit,
  resolveProcessExitCause
} from './terminal-exit-cause'

describe('resolveProcessExitCause', () => {
  it('reports a signalled death as a signal, not as the zero node-pty pairs with it', () => {
    expect(resolveProcessExitCause({ exitCode: 0, signal: 9 })).toEqual({
      kind: 'signaled',
      signal: 9
    })
  })

  it('refuses to read a status the host cannot report', () => {
    // macOS wraps every PTY in `login -flpq`, which returns 0 for a shell that
    // exited 42 and 0 for one that was SIGKILLed.
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

  it('keeps a real status when the host vouches for it', () => {
    expect(resolveProcessExitCause({ exitCode: 42, signal: 0 })).toEqual({
      kind: 'exited',
      exitCode: 42
    })
    expect(resolveProcessExitCause({ exitCode: 0 })).toEqual({ kind: 'exited', exitCode: 0 })
  })

  it('treats a missing signal as no signal rather than as unknown', () => {
    expect(resolveProcessExitCause({ exitCode: 7, signal: null })).toEqual({
      kind: 'exited',
      exitCode: 7
    })
  })
})

describe('describeTerminalExitCause', () => {
  it('gives every cause a sentence that does not need a number decoded', () => {
    expect(describeTerminalExitCause({ kind: 'operator_close' })).toBe(
      'Terminal closed by operator request'
    )
    expect(describeTerminalExitCause({ kind: 'signaled', signal: 9 })).toBe(
      'Agent process killed by signal 9'
    )
    expect(describeTerminalExitCause({ kind: 'exited', exitCode: 3 })).toBe(
      'Agent process exited with code 3'
    )
    expect(describeTerminalExitCause({ kind: 'unknown', reason: 'stop_unverified' })).toBe(
      'Agent process stop was requested but never confirmed'
    )
    expect(describeTerminalExitCause({ kind: 'unknown', reason: 'host_status_unavailable' })).toBe(
      'Agent process ended; this host cannot report why'
    )
  })
})

describe('isDeliberateTerminalExit', () => {
  it('counts only an operator close as deliberate', () => {
    expect(isDeliberateTerminalExit({ kind: 'operator_close' })).toBe(true)
    expect(isDeliberateTerminalExit({ kind: 'exited', exitCode: 0 })).toBe(false)
    expect(isDeliberateTerminalExit({ kind: 'signaled', signal: 9 })).toBe(false)
    expect(isDeliberateTerminalExit({ kind: 'unknown', reason: 'stop_unverified' })).toBe(false)
  })
})
