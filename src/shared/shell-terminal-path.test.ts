import { afterEach, describe, expect, it, vi } from 'vitest'

const { runProcess } = vi.hoisted(() => ({ runProcess: vi.fn() }))
vi.mock('./child-process/run-process', () => ({ runProcess }))
import { readShellTerminalPath } from './shell-process-readiness'

afterEach(() => {
  vi.unstubAllGlobals()
  runProcess.mockReset()
})

function platform(value: string): void {
  vi.stubGlobal('process', { ...process, platform: value })
}

function result(stdout: string, overrides: Record<string, unknown> = {}): void {
  runProcess.mockResolvedValue({
    stdout,
    stderr: '',
    code: 0,
    timedOut: false,
    outputTruncated: false,
    ...overrides
  })
}

describe('shell terminal device discovery', () => {
  it.each([
    ['darwin', '  ttys048\n', '/dev/ttys048'],
    ['linux', 'pts/12\n', '/dev/pts/12'],
    ['linux', '/dev/pts/0\n', '/dev/pts/0']
  ])('resolves the %s shell controlling terminal from %j', async (os, stdout, expected) => {
    platform(os)
    result(`4321 ${stdout}`)
    await expect(readShellTerminalPath(4321, 4321)).resolves.toBe(expected)
    expect(runProcess).toHaveBeenCalledOnce()
    expect(runProcess).toHaveBeenCalledWith(
      expect.objectContaining({
        program: 'ps',
        args: ['-p', '4321', '-o', 'pid=,tty='],
        timeoutMs: expect.any(Number),
        maxOutputBytes: expect.any(Number)
      })
    )
  })

  it.each(['?', '??', '', 'tty1', 'pts/1\npts/2', 'pts/../1', 'pts/1\n4321 pts/1'])(
    'rejects unknown, non-PTY, or ambiguous terminal output %j',
    async (stdout) => {
      platform('linux')
      result(`4321 ${stdout}`)
      await expect(readShellTerminalPath(4321, 4321)).resolves.toBeNull()
    }
  )

  it.each([{ code: 1 }, { timedOut: true }, { outputTruncated: true }])(
    'does not trust a plausible device from an unsuccessful probe: %j',
    async (failure) => {
      platform('linux')
      result('4321 pts/12\n', failure)
      await expect(readShellTerminalPath(4321, 4321)).resolves.toBeNull()
    }
  )

  it.each([0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
    'does not invoke process inspection for invalid PID %s',
    async (pid) => {
      platform('linux')
      await expect(readShellTerminalPath(pid, 4321)).resolves.toBeNull()
      expect(runProcess).not.toHaveBeenCalled()
    }
  )

  it.each([
    ['42 pts/3\n', '41 pts/3\n', '/dev/pts/3'],
    ['42 ttys048\n', '41 ttys048\n', '/dev/ttys048'],
    ['42 pts/3\n', '41 pts/4\n', null],
    ['42 pts/3\n', '', null],
    ['', '41 pts/3\n', null],
    ['42 ?\n', '41 ?\n', null],
    ['42 pts/3\n', '99 pts/3\n', null]
  ])('binds shell and login wrapper using single-PID queries', async (shell, wrapper, expected) => {
    platform('darwin')
    runProcess.mockResolvedValueOnce({ code: 0, stdout: shell })
    runProcess.mockResolvedValueOnce({ code: 0, stdout: wrapper })
    await expect(readShellTerminalPath(42, 41)).resolves.toBe(expected)
    expect(runProcess.mock.calls.map(([spec]) => spec.args)).toEqual([
      ['-p', '42', '-o', 'pid=,tty='],
      ['-p', '41', '-o', 'pid=,tty=']
    ])
  })

  it.each([0, -1, Number.NaN, 1.5])('rejects invalid spawned PID %s', async (pid) => {
    platform('linux')
    await expect(readShellTerminalPath(42, pid)).resolves.toBeNull()
    expect(runProcess).not.toHaveBeenCalled()
  })

  it('does not run POSIX inspection on Windows', async () => {
    platform('win32')
    await expect(readShellTerminalPath(4321, 4321)).resolves.toBeNull()
    expect(runProcess).not.toHaveBeenCalled()
  })
})
