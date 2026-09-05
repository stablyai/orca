import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }))

vi.mock('node:child_process', () => ({ execFile: execFileMock }))

import {
  getCheapProcessTableSnapshot,
  resetCheapProcessTableSnapshotForTests
} from './cheap-process-table-snapshot-reader'
import {
  CHEAP_PS_ARGS,
  PS_ARGS,
  PS_MAX_BUFFER_BYTES,
  parseCheapProcessTableRows,
  ProcessTableCaptureError
} from './process-table-snapshot'

function installPs(stdout: string): string[][] {
  const calls: string[][] = []
  execFileMock.mockImplementation((cmd: string, args: string[], _opts: unknown, cb: unknown) => {
    calls.push([cmd, ...args])
    ;(cb as (err: unknown, result: { stdout: string; stderr: string }) => void)(null, {
      stdout,
      stderr: ''
    })
  })
  return calls
}

describe('parseCheapProcessTableRows', () => {
  it('parses the macOS column set with a padded lstart marker', () => {
    const rows = parseCheapProcessTableRows(
      [
        '    1     0     1    0 Ss   Tue Sep  1 01:49:39 2026',
        ' 4242  4200  4242 4243 S    Thu Sep  3 16:02:01 2026',
        ' 4243  4242  4243 4243 S+   Thu Sep  3 16:02:05 2026',
        ''
      ].join('\n')
    )
    expect(rows).toEqual([
      { pid: 1, ppid: 0, pgid: 1, tpgid: 0, stat: 'Ss', startTime: 'Tue Sep  1 01:49:39 2026' },
      {
        pid: 4242,
        ppid: 4200,
        pgid: 4242,
        tpgid: 4243,
        stat: 'S',
        startTime: 'Thu Sep  3 16:02:01 2026'
      },
      {
        pid: 4243,
        ppid: 4242,
        pgid: 4243,
        tpgid: 4243,
        stat: 'S+',
        startTime: 'Thu Sep  3 16:02:05 2026'
      }
    ])
  })

  it('parses the Linux column set, which carries no start marker', () => {
    const rows = parseCheapProcessTableRows(
      '   2     0     0   -1 S\r\n 900   1   900  900 Ss+\r\n'
    )
    expect(rows).toEqual([
      { pid: 2, ppid: 0, pgid: 0, tpgid: -1, stat: 'S' },
      { pid: 900, ppid: 1, pgid: 900, tpgid: 900, stat: 'Ss+' }
    ])
  })

  it('skips malformed rows rather than failing the capture', () => {
    expect(parseCheapProcessTableRows('garbage\n 7 1 7 7 S\n')).toEqual([
      { pid: 7, ppid: 1, pgid: 7, tpgid: 7, stat: 'S' }
    ])
  })

  it('treats an empty capture as unreadable, never as "no processes"', () => {
    expect(() => parseCheapProcessTableRows('\n\n')).toThrow(ProcessTableCaptureError)
  })
})

describe('getCheapProcessTableSnapshot', () => {
  beforeEach(() => {
    execFileMock.mockReset()
    resetCheapProcessTableSnapshotForTests()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(0)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('forks ps with the cheap column set only, never tty or command', async () => {
    const calls = installPs(' 7 1 7 7 S\n')
    await getCheapProcessTableSnapshot()
    expect(calls).toEqual([['ps', ...CHEAP_PS_ARGS]])
    expect(CHEAP_PS_ARGS.join(' ')).not.toMatch(/tty=|command=|etimes=/)
    expect(CHEAP_PS_ARGS).not.toEqual(PS_ARGS)
  })

  it('coalesces concurrent readers onto one fork and honours the TTL', async () => {
    const calls = installPs(' 7 1 7 7 S\n')
    await Promise.all([getCheapProcessTableSnapshot(), getCheapProcessTableSnapshot()])
    await getCheapProcessTableSnapshot()
    expect(calls).toHaveLength(1)
    vi.setSystemTime(600)
    await getCheapProcessTableSnapshot()
    expect(calls).toHaveLength(2)
  })

  it('names a capture at the buffer ceiling as truncated', async () => {
    execFileMock.mockImplementation((_c: string, _a: string[], _o: unknown, cb: unknown) => {
      ;(cb as (err: unknown) => void)(
        Object.assign(new Error('maxBuffer'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' })
      )
    })
    await expect(getCheapProcessTableSnapshot()).rejects.toMatchObject({
      reason: 'capture_truncated'
    })
    resetCheapProcessTableSnapshotForTests()
    installPs(' 7 1 7 7 S\n'.padEnd(PS_MAX_BUFFER_BYTES, ' '))
    await expect(getCheapProcessTableSnapshot()).rejects.toMatchObject({
      reason: 'capture_truncated'
    })
  })
})
