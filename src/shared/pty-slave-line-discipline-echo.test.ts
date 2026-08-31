import { describe, expect, it, vi, beforeEach } from 'vitest'

const execFileMock = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', () => ({ execFile: execFileMock }))

import { createPtySlaveLineEditorProbe, readPtySlavePath } from './pty-slave-line-discipline-echo'

/** Replies to the next stty call with the given output, or an error when `output` is null. */
function answerStty(output: string | null): void {
  execFileMock.mockImplementationOnce((_cmd, _args, _opts, cb) => {
    cb(output === null ? new Error('stty: no such file') : null, output ?? '', '')
  })
}

const COOKED = 'speed 38400 baud;\nlflags: icanon isig iexten echo echoe echok echoctl\n'
const RAW = 'speed 38400 baud;\nlflags: -icanon -isig -iexten -echo -echoe -echok -echoctl\n'
const LINE_EDITOR = `${RAW}cchars: lnext = <undef>; min = 1; time = 0;\n`

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

describe('createPtySlaveLineEditorProbe', () => {
  it('requires raw quiet mode with the line editor disabling literal-next', async () => {
    const probe = createPtySlaveLineEditorProbe('/dev/ttys048', 'darwin')
    answerStty(LINE_EDITOR)
    await expect(probe?.()).resolves.toBe('line-editor')
    answerStty(`${RAW}cchars: lnext = ^V; min = 1; time = 0;\n`)
    await expect(probe?.()).resolves.toBe('other')
    answerStty(COOKED)
    await expect(probe?.()).resolves.toBe('other')
  })

  it('fails closed when the terminal state is incomplete', async () => {
    const probe = createPtySlaveLineEditorProbe('/dev/ttys048', 'darwin')
    answerStty('lflags: -echo\ncchars: lnext = <undef>;\n')
    await expect(probe?.()).resolves.toBe('unknown')
  })
  // These cover createSttyProbe, which the line-editor probe shares. The ECHO probe that
  // used to exercise them is gone, but the subprocess machinery under it is still live.
  it('shares one in-flight stty process per PTY', async () => {
    const probe = createPtySlaveLineEditorProbe('/dev/ttys048', 'darwin')
    const pending: { finish?: () => void } = {}
    execFileMock.mockImplementationOnce((_cmd, _args, _opts, callback) => {
      pending.finish = () => callback(null, LINE_EDITOR, '')
    })

    const first = probe?.()
    const second = probe?.()
    expect(execFileMock).toHaveBeenCalledTimes(1)
    pending.finish?.()
    await expect(first).resolves.toBe('line-editor')
    await expect(second).resolves.toBe('line-editor')
  })

  it('passes the device with the flag its own platform understands', async () => {
    answerStty(LINE_EDITOR)
    await createPtySlaveLineEditorProbe('/dev/ttys048', 'darwin')?.()
    expect(execFileMock.mock.calls[0]?.[1]).toEqual(['-a', '-f', '/dev/ttys048'])
    answerStty(LINE_EDITOR)
    await createPtySlaveLineEditorProbe('/dev/pts/3', 'linux')?.()
    expect(execFileMock.mock.calls[1]?.[1]).toEqual(['-a', '-F', '/dev/pts/3'])
  })

  it('keeps probing after a transient failure and only latches a permanent one', async () => {
    const probe = createPtySlaveLineEditorProbe('/dev/ttys048', 'darwin')
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
    execFileMock.mockImplementationOnce((_c, _a, _o, cb) => cb(null, LINE_EDITOR, ''))
    await expect(probe?.()).resolves.toBe('line-editor')
    expect(execFileMock).toHaveBeenCalledTimes(4)

    // A non-zero exit means the device is gone or was never a tty: permanent.
    execFileMock.mockImplementationOnce((_c, _a, _o, cb) =>
      cb(Object.assign(new Error('not a tty'), { code: 1 }), '', '')
    )
    await expect(probe?.()).resolves.toBe('unavailable')
    await expect(probe?.()).resolves.toBe('unavailable')
    expect(execFileMock).toHaveBeenCalledTimes(5)
  })
})
