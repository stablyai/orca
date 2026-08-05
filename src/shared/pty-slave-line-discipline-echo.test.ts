import { describe, expect, it, vi, beforeEach } from 'vitest'

const execFileMock = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', () => ({ execFile: execFileMock }))

import { createPtySlaveEchoProbe, readPtySlavePath } from './pty-slave-line-discipline-echo'

/** Replies to the next stty call with the given output, or an error when `output` is null. */
function answerStty(output: string | null): void {
  execFileMock.mockImplementationOnce((_cmd, _args, _opts, cb) => {
    cb(output === null ? new Error('stty: no such file') : null, output ?? '', '')
  })
}

const COOKED = 'speed 38400 baud;\nlflags: icanon isig iexten echo echoe echok echoctl\n'
const RAW = 'speed 38400 baud;\nlflags: -icanon -isig -iexten -echo -echoe -echok -echoctl\n'

beforeEach(() => {
  execFileMock.mockReset()
})

describe('readPtySlavePath', () => {
  it('reads node-pty ptsName and rejects every shape that is not a usable path', () => {
    expect(readPtySlavePath({ ptsName: '/dev/ttys048' })).toBe('/dev/ttys048')
    // A ConPTY terminal has no ptsName at all, and an empty one names no device.
    expect(readPtySlavePath({})).toBeUndefined()
    expect(readPtySlavePath({ ptsName: '' })).toBeUndefined()
    expect(readPtySlavePath({ ptsName: 12 })).toBeUndefined()
    expect(readPtySlavePath(undefined)).toBeUndefined()
    expect(readPtySlavePath(null)).toBeUndefined()
  })
})

describe('createPtySlaveEchoProbe', () => {
  it('has no probe to offer when there is no POSIX slave to read', () => {
    expect(createPtySlaveEchoProbe('/dev/ttys048', 'win32')).toBeUndefined()
    expect(createPtySlaveEchoProbe(undefined, 'darwin')).toBeUndefined()
  })

  it('reads the ECHO bit off the slave', async () => {
    const probe = createPtySlaveEchoProbe('/dev/ttys048', 'darwin')
    answerStty(COOKED)
    await expect(probe?.()).resolves.toBe('echoing')
    answerStty(RAW)
    await expect(probe?.()).resolves.toBe('quiet')
  })

  it('does not read `echoctl` or `echoe` as the ECHO bit', async () => {
    const probe = createPtySlaveEchoProbe('/dev/ttys048', 'darwin')
    // Why: a substring match on "echo" reports echoing for a raw tty that merely keeps
    // echoctl set, which is the exact tty the write must not be held back for.
    answerStty('lflags: -icanon -echo echoe echok echoctl echoke\n')
    await expect(probe?.()).resolves.toBe('quiet')
  })

  it('reports unknown rather than quiet when the slave cannot be read', async () => {
    const probe = createPtySlaveEchoProbe('/dev/ttys048', 'darwin')
    answerStty(null)
    await expect(probe?.()).resolves.toBe('unknown')
  })

  it('reports unknown when the output carries no echo flag at all', async () => {
    const probe = createPtySlaveEchoProbe('/dev/ttys048', 'darwin')
    answerStty('speed 38400 baud;\n')
    await expect(probe?.()).resolves.toBe('unknown')
  })

  it('stops spawning stty once it has failed, but keeps re-reading a live slave', async () => {
    const probe = createPtySlaveEchoProbe('/dev/ttys048', 'darwin')
    answerStty(null)
    await probe?.()
    await probe?.()
    await probe?.()
    expect(execFileMock).toHaveBeenCalledTimes(1)

    // The bit itself is what changes, so a working probe is never cached.
    const live = createPtySlaveEchoProbe('/dev/ttys048', 'darwin')
    answerStty(COOKED)
    await expect(live?.()).resolves.toBe('echoing')
    answerStty(RAW)
    await expect(live?.()).resolves.toBe('quiet')
    expect(execFileMock).toHaveBeenCalledTimes(3)
  })

  it('keeps probing after a transient failure and only latches a permanent one', async () => {
    const probe = createPtySlaveEchoProbe('/dev/ttys048', 'darwin')
    // Why: a multi-pane restore forks these in a burst, so EAGAIN and the timeout kill
    // are contention — condemning the pty to guessing for its whole life on one of
    // those is the failure mode, not the protection.
    for (const transient of [
      Object.assign(new Error('spawn EAGAIN'), { code: 'EAGAIN' }),
      Object.assign(new Error('killed'), { killed: true }),
      Object.assign(new Error('too many files'), { code: 'EMFILE' })
    ]) {
      execFileMock.mockImplementationOnce((_c, _a, _o, cb) => cb(transient, '', ''))
      await expect(probe?.()).resolves.toBe('unknown')
    }
    execFileMock.mockImplementationOnce((_c, _a, _o, cb) => cb(null, RAW, ''))
    await expect(probe?.()).resolves.toBe('quiet')
    expect(execFileMock).toHaveBeenCalledTimes(4)

    // A non-zero exit means the device is gone or was never a tty: permanent.
    execFileMock.mockImplementationOnce((_c, _a, _o, cb) =>
      cb(Object.assign(new Error('not a tty'), { code: 1 }), '', '')
    )
    await expect(probe?.()).resolves.toBe('unknown')
    await expect(probe?.()).resolves.toBe('unknown')
    expect(execFileMock).toHaveBeenCalledTimes(5)
  })

  it('passes the device with the flag its own platform understands', async () => {
    answerStty(RAW)
    await createPtySlaveEchoProbe('/dev/ttys048', 'darwin')?.()
    expect(execFileMock.mock.calls[0]?.[1]).toEqual(['-a', '-f', '/dev/ttys048'])
    answerStty(RAW)
    await createPtySlaveEchoProbe('/dev/pts/3', 'linux')?.()
    expect(execFileMock.mock.calls[1]?.[1]).toEqual(['-a', '-F', '/dev/pts/3'])
  })
})
