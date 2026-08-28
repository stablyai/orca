import { describe, expect, it } from 'vitest'
import { decodePosixWaitStatus, describePosixWaitStatus } from './posix-wait-status'

describe('decodePosixWaitStatus', () => {
  it('decodes normal exits from the high byte', () => {
    expect(decodePosixWaitStatus(61696)).toEqual({ kind: 'exited', exitStatus: 241 })
    expect(decodePosixWaitStatus(512)).toEqual({ kind: 'exited', exitStatus: 2 })
    expect(decodePosixWaitStatus(0)).toEqual({ kind: 'exited', exitStatus: 0 })
  })

  it('decodes signal terminations with the core-dump flag', () => {
    expect(decodePosixWaitStatus(9)).toEqual({
      kind: 'signaled',
      signal: 9,
      signalName: 'SIGKILL',
      coreDumped: false
    })
    expect(decodePosixWaitStatus(133)).toEqual({
      kind: 'signaled',
      signal: 5,
      signalName: 'SIGTRAP',
      coreDumped: true
    })
  })

  it('leaves platform-divergent signal numbers unnamed', () => {
    // 7 = SIGBUS on Linux but SIGEMT on macOS; naming it would mislabel one of them.
    expect(decodePosixWaitStatus(7)).toEqual({
      kind: 'signaled',
      signal: 7,
      signalName: null,
      coreDumped: false
    })
  })

  it('rejects values that are not dead-process wait statuses', () => {
    expect(decodePosixWaitStatus(-536870904)).toBeNull()
    expect(decodePosixWaitStatus(0x10000)).toBeNull()
    expect(decodePosixWaitStatus(0x7f)).toBeNull()
    expect(decodePosixWaitStatus(0.5)).toBeNull()
  })
})

describe('describePosixWaitStatus', () => {
  it('phrases each decode shape', () => {
    expect(describePosixWaitStatus({ kind: 'exited', exitStatus: 241 })).toBe('exit status 241')
    expect(
      describePosixWaitStatus({
        kind: 'signaled',
        signal: 9,
        signalName: 'SIGKILL',
        coreDumped: false
      })
    ).toBe('SIGKILL')
    expect(
      describePosixWaitStatus({
        kind: 'signaled',
        signal: 5,
        signalName: 'SIGTRAP',
        coreDumped: true
      })
    ).toBe('SIGTRAP, core dumped')
    expect(
      describePosixWaitStatus({ kind: 'signaled', signal: 7, signalName: null, coreDumped: false })
    ).toBe('signal 7')
  })
})
