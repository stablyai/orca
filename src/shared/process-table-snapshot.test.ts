import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }))

vi.mock('node:child_process', () => ({ execFile: execFileMock }))

import {
  createProcessTableSnapshotReader,
  getProcessTableSnapshot,
  getStrictProcessTableSnapshot,
  getStrictProcessTableSnapshotWithAge,
  PROCESS_TABLE_EVIDENCE_BUDGET_MS,
  PS_MAX_BUFFER_BYTES,
  PS_TIMEOUT_MS,
  resetProcessTableSnapshotForTests
} from './process-table-snapshot-reader'
import {
  parseProcessTableRows,
  parseStrictProcessTableRows,
  ProcessTableCaptureError
} from './process-table-snapshot'
import { buildProcessTableIndex, getProcessTableIndex } from './process-table-index'

function deferred<T>(): {
  promise: Promise<T>
  resolve: (v: T) => void
  reject: (e: unknown) => void
} {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('process-table-snapshot reader', () => {
  it('collapses concurrent calls into a single ps scan', async () => {
    let scans = 0
    const gate = deferred<string>()
    const reader = createProcessTableSnapshotReader({
      runPs: () => {
        scans += 1
        return gate.promise
      },
      now: () => 0
    })

    const a = reader.getSnapshot()
    const b = reader.getSnapshot()
    const c = reader.getSnapshot()
    gate.resolve('ps-output')

    expect(await a).toBe('ps-output')
    expect(await b).toBe('ps-output')
    expect(await c).toBe('ps-output')
    // In-flight sharing must collapse a pane burst into one ps fork.
    expect(scans).toBe(1)
  })

  it('reuses the cached snapshot within the TTL window', async () => {
    let scans = 0
    let clock = 0
    const reader = createProcessTableSnapshotReader({
      runPs: () => {
        scans += 1
        return Promise.resolve(`scan-${scans}`)
      },
      now: () => clock,
      ttlMs: 500
    })

    expect(await reader.getSnapshot()).toBe('scan-1')
    clock = 499
    expect(await reader.getSnapshot()).toBe('scan-1')
    expect(scans).toBe(1)
  })

  it('rescans once the TTL expires', async () => {
    let scans = 0
    let clock = 0
    const reader = createProcessTableSnapshotReader({
      runPs: () => {
        scans += 1
        return Promise.resolve(`scan-${scans}`)
      },
      now: () => clock,
      ttlMs: 500
    })

    expect(await reader.getSnapshot()).toBe('scan-1')
    clock = 500
    expect(await reader.getSnapshot()).toBe('scan-2')
    expect(scans).toBe(2)
  })

  it('stamps capture time after the scan resolves so a slow ps cannot serve a stale snapshot', async () => {
    let scans = 0
    let clock = 0
    const gate = deferred<string>()
    const reader = createProcessTableSnapshotReader({
      runPs: () => {
        scans += 1
        return scans === 1 ? gate.promise : Promise.resolve(`scan-${scans}`)
      },
      now: () => clock,
      ttlMs: 500
    })

    const first = reader.getSnapshot()
    // The scan takes 600ms of wall clock to return — longer than the TTL.
    clock = 600
    gate.resolve('scan-1')
    expect(await first).toBe('scan-1')

    // TTL starts at completion (600), so 900 is still cached.
    clock = 900
    expect(await reader.getSnapshot()).toBe('scan-1')
    expect(scans).toBe(1)
  })

  it('reports the age of the capture instant, not of the moment ps finished', async () => {
    let clock = 0
    const gate = deferred<string>()
    const reader = createProcessTableSnapshotReader({
      runPs: () => gate.promise,
      now: () => clock,
      ttlMs: 500
    })

    const first = reader.getSnapshot()
    // A capture that took 4s of wall clock describes the machine as it was 4s ago.
    clock = 4_000
    gate.resolve('scan-1')
    await first

    // Starting age at completion previously admitted already-stale captures to destructive consumers.
    expect((await reader.getSnapshotWithAge()).capturedAgeMs).toBe(4_000)
  })

  it('reports an older input’s age in whole milliseconds, rounded older, for the integer-only wire', async () => {
    const clock = 10_000
    const reader = createProcessTableSnapshotReader({
      // Recovered argv read 750.5ms before the capture, converted from the monotonic clock.
      runPs: async (_fresh, inputAt) => {
        inputAt(clock - 750.5)
        return 'scan'
      },
      now: () => clock,
      ttlMs: 500
    })

    expect((await reader.getSnapshotWithAge()).capturedAgeMs).toBe(751)
  })

  it('does not cache failures and retries on the next call', async () => {
    let scans = 0
    const reader = createProcessTableSnapshotReader({
      runPs: () => {
        scans += 1
        if (scans === 1) {
          return Promise.reject(new Error('ps timed out'))
        }
        return Promise.resolve('recovered')
      },
      now: () => 0
    })

    await expect(reader.getSnapshot()).rejects.toThrow('ps timed out')
    // Transient failures must clear the cache so the next inspection can recover.
    expect(await reader.getSnapshot()).toBe('recovered')
    expect(scans).toBe(2)
  })

  it('forces a post-request scan even when a same-tick cache exists', async () => {
    let scans = 0
    const reader = createProcessTableSnapshotReader({
      runPs: async () => `scan-${++scans}`,
      now: () => 0
    })

    expect(await reader.getSnapshot()).toBe('scan-1')
    expect(await reader.getFreshSnapshot()).toBe('scan-2')
    expect(scans).toBe(2)
  })

  it('shares same-turn fresh requests but queues one scan after a pre-existing scan', async () => {
    let scans = 0
    const first = deferred<string>()
    const second = deferred<string>()
    const reader = createProcessTableSnapshotReader({
      runPs: () => {
        scans += 1
        return scans === 1 ? first.promise : second.promise
      },
      now: () => 0
    })

    const stale = reader.getSnapshot()
    const freshA = reader.getFreshSnapshot()
    const freshB = reader.getFreshSnapshot()
    expect(scans).toBe(1)
    first.resolve('stale')
    expect(await stale).toBe('stale')
    await Promise.resolve()
    expect(scans).toBe(2)
    second.resolve('fresh')
    expect(await freshA).toBe('fresh')
    expect(await freshB).toBe('fresh')
    expect(scans).toBe(2)
  })

  it('does not let an ordinary same-turn miss race a queued fresh scan', async () => {
    let scans = 0
    const reader = createProcessTableSnapshotReader({
      runPs: async () => `scan-${++scans}`,
      now: () => 0
    })

    const fresh = reader.getFreshSnapshot()
    const ordinary = reader.getSnapshot()

    await expect(Promise.all([fresh, ordinary])).resolves.toEqual(['scan-1', 'scan-1'])
    expect(scans).toBe(1)
  })
})

describe('shared process-table capture', () => {
  beforeEach(() => {
    execFileMock.mockReset()
    resetProcessTableSnapshotForTests()
  })

  function mockPsCaptures(...stdouts: string[]): () => number {
    let forks = 0
    execFileMock.mockImplementation(
      (_command: string, _args: string[], _options: unknown, callback: unknown) => {
        const stdout = stdouts[Math.min(forks, stdouts.length - 1)] ?? ''
        forks += 1
        ;(callback as (err: unknown, result: { stdout: string; stderr: string }) => void)(null, {
          stdout,
          stderr: ''
        })
      }
    )
    return () => forks
  }

  it('serves the strict and lenient views from ONE ps fork per TTL window', async () => {
    // Both views use identical argv; separate caches doubled relay idle forks (#6288).
    const tty = process.platform === 'darwin' ? '??' : '?'
    const forks = mockPsCaptures(
      `100 1 100 100 Ss+ ${tty} Fri Oct 9 12:34:56 2026 /bin/zsh\n`,
      `200 1 200 200 Ss+ ${tty} Fri Oct 9 12:34:56 2026 /bin/bash\n`
    )

    const [lenient, strict] = await Promise.all([
      getProcessTableSnapshot(),
      getStrictProcessTableSnapshot()
    ])

    expect(forks()).toBe(1)
    expect(lenient.map((row) => row.pid)).toEqual([100])
    expect(strict.map((row) => row.pid)).toEqual([100])
  })

  it('reuses the cached capture for a later strict read inside the TTL', async () => {
    const tty = process.platform === 'darwin' ? '??' : '?'
    const forks = mockPsCaptures(
      `100 1 100 100 Ss+ ${tty} Fri Oct 9 12:34:56 2026 /bin/zsh\n`,
      `200 1 200 200 Ss+ ${tty} Fri Oct 9 12:34:56 2026 /bin/bash\n`
    )

    await getProcessTableSnapshot()
    const strict = await getStrictProcessTableSnapshot()

    expect(forks()).toBe(1)
    expect(strict).toEqual([
      {
        pid: 100,
        ppid: 1,
        pgid: 100,
        tpgid: 100,
        stat: 'Ss+',
        tty,
        ...(process.platform === 'linux' ? {} : { startTime: 'Fri Oct 9 12:34:56 2026' }),
        command: '/bin/zsh'
      }
    ])
  })

  it('keeps the lenient view readable when the same capture is strictly unreadable', async () => {
    const forks = mockPsCaptures('100 1 Ss+ /bin/zsh\n')

    const lenient = await getProcessTableSnapshot()
    await expect(getStrictProcessTableSnapshot()).rejects.toBeInstanceOf(ProcessTableCaptureError)

    expect(forks()).toBe(process.platform === 'darwin' ? 2 : 1)
    expect(lenient).toEqual([{ pid: 100, ppid: 1, stat: 'Ss+', command: '/bin/zsh' }])
  })
})

describe('parseProcessTableRows', () => {
  it('parses pid/ppid/stat and keeps the full command (including spaces)', () => {
    const rows = parseProcessTableRows(
      ['501 1 S /bin/zsh', '600 501 S+ node /path/bin/codex --flag'].join('\n')
    )
    expect(rows).toEqual([
      { pid: 501, ppid: 1, stat: 'S', command: '/bin/zsh' },
      {
        pid: 600,
        ppid: 501,
        stat: 'S+',
        command: 'node /path/bin/codex --flag'
      }
    ])
  })

  it('tolerates CRLF and skips header/blank/non-matching lines', () => {
    const rows = parseProcessTableRows('  PID PPID STAT COMMAND\r\n42 1 Ss /sbin/launchd\r\n\r\n')
    expect(rows).toEqual([{ pid: 42, ppid: 1, stat: 'Ss', command: '/sbin/launchd' }])
  })
})

describe('parseStrictProcessTableRows', () => {
  it('accepts Linux kernel roots and bracketed comm values', () => {
    const capture = readFileSync(
      join(__dirname, '__fixtures__', 'linux-process-table-kernel-rows.txt'),
      'utf8'
    )
    expect(parseStrictProcessTableRows(capture)).toEqual([
      { pid: 1, ppid: 0, pgid: 1, tpgid: 0, stat: 'Ss', command: '/sbin/init' },
      { pid: 2, ppid: 0, pgid: 0, tpgid: -1, stat: 'S', command: '[kthreadd]' },
      {
        pid: 3,
        ppid: 2,
        pgid: 0,
        tpgid: -1,
        stat: 'I',
        command: '[pool_workqueue_release]'
      },
      {
        pid: 4,
        ppid: 2,
        pgid: 0,
        tpgid: -1,
        stat: 'I',
        command: '[kworker/R-rcu_g]'
      },
      {
        pid: 5,
        ppid: 2,
        pgid: 0,
        tpgid: -1,
        stat: 'I',
        command: '[kworker/R-sync_wq]'
      },
      {
        pid: 6,
        ppid: 2,
        pgid: 0,
        tpgid: -1,
        stat: 'I',
        command: '[kworker/R-slub_]'
      },
      {
        pid: 100,
        ppid: 1,
        pgid: 100,
        tpgid: 100,
        stat: 'Ss+',
        command: '/bin/bash -l'
      },
      {
        pid: 101,
        ppid: 100,
        pgid: 101,
        tpgid: 101,
        stat: 'S+',
        command: 'node /opt/codex'
      }
    ])
  })

  it('extracts pgid/tpgid across CRLF framing while retaining command spacing', () => {
    expect(
      parseStrictProcessTableRows(
        ' PID PPID PGID TPGID STAT COMMAND\r\n 100 1 100 101 Ss /bin/zsh -l\r\n 101 100 101 101 S+ node /opt/codex --flag  value\r\n'
      )
    ).toEqual([
      {
        pid: 100,
        ppid: 1,
        pgid: 100,
        tpgid: 101,
        stat: 'Ss',
        command: '/bin/zsh -l'
      },
      {
        pid: 101,
        ppid: 100,
        pgid: 101,
        tpgid: 101,
        stat: 'S+',
        command: 'node /opt/codex --flag  value'
      }
    ])
  })

  it('accepts no-controlling-tty sentinels for later unverifiable classification', () => {
    expect(parseStrictProcessTableRows('100 1 100 0 Ss /bin/zsh')).toEqual([
      {
        pid: 100,
        ppid: 1,
        pgid: 100,
        tpgid: 0,
        stat: 'Ss',
        command: '/bin/zsh'
      }
    ])
    expect(parseStrictProcessTableRows('100 1 100 -1 Ss /bin/zsh')).toEqual([
      {
        pid: 100,
        ppid: 1,
        pgid: 100,
        tpgid: -1,
        stat: 'Ss',
        command: '/bin/zsh'
      }
    ])
  })

  it('still rejects truncated captures as unreadable', () => {
    expect(() => parseStrictProcessTableRows('100 1 100 100 Ss+')).toThrow(ProcessTableCaptureError)
  })

  it.each([
    '0 0 0 0 S [invalid-pid]',
    '100 1 -1 100 S [invalid-pgid]',
    '100 1 100 -2 S [invalid-tpgid]'
  ])('rejects domain-invalid numeric values (%s)', (capture) => {
    expect(() => parseStrictProcessTableRows(capture)).toThrow(ProcessTableCaptureError)
  })

  it('rejects an empty or header-only capture as unreadable', () => {
    expect(() => parseStrictProcessTableRows('')).toThrow(ProcessTableCaptureError)
    expect(() => parseStrictProcessTableRows('PID PPID PGID TPGID STAT COMMAND')).toThrow(
      ProcessTableCaptureError
    )
  })
})

describe('getProcessTableIndex', () => {
  it('reuses one index for the same snapshot identity', () => {
    const rows = parseProcessTableRows(
      ['100 1 Ss bash', '101 100 S node codex', '102 100 S vim'].join('\n')
    )

    const first = getProcessTableIndex(rows)
    const second = getProcessTableIndex(rows)

    expect(second).toBe(first)
    expect(first.byPid.get(100)).toBe(rows[0])
    expect(first.childrenByPpid.get(100)).toEqual([rows[1], rows[2]])
  })

  it('does not reuse an index across distinct snapshot arrays', () => {
    const firstRows = parseProcessTableRows('100 1 Ss bash')
    const secondRows = parseProcessTableRows('100 1 Ss bash')

    expect(getProcessTableIndex(secondRows)).not.toBe(getProcessTableIndex(firstRows))
  })

  it('resolves a duplicated pid to the FIRST row, as `rows.find()` did', () => {
    // Keep the first row like rows.find: argv newlines can create later spurious duplicate-PID rows.
    const rows = parseProcessTableRows(['100 1 Ss bash', '100 1 Ss+ zsh'].join('\n'))

    expect(getProcessTableIndex(rows).byPid.get(100)).toBe(rows[0])
    expect(buildProcessTableIndex(rows).byPid.get(100)).toBe(rows[0])
  })
})

describe('process-table capture completeness', () => {
  const NODE_DEFAULT_MAX_BUFFER_BYTES = 1024 * 1024

  beforeEach(() => {
    execFileMock.mockReset()
    resetProcessTableSnapshotForTests()
  })

  /** Emulate Node’s maxBuffer kill/error plus truncated bytes; always-resolving mocks would hide the actual ceiling. */
  function mockPsWithNodeBufferSemantics(stdout: string): void {
    execFileMock.mockImplementation(
      (_command: string, _args: string[], options: unknown, callback: unknown) => {
        const done = callback as (err: unknown, result: { stdout: string; stderr: string }) => void
        const maxBuffer =
          (options as { maxBuffer?: number })?.maxBuffer ?? NODE_DEFAULT_MAX_BUFFER_BYTES
        if (Buffer.byteLength(stdout, 'utf-8') > maxBuffer) {
          const error = Object.assign(new Error('stdout maxBuffer length exceeded'), {
            code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
          })
          done(error, { stdout: stdout.slice(0, maxBuffer), stderr: '' })
          return
        }
        done(null, { stdout, stderr: '' })
      }
    )
  }

  function busyHostTable(processCount: number): string {
    // ~285 bytes/row, so 4k processes clears 1MB the way a real busy host does.
    const argv = `/usr/bin/node ${'--inspect-brk-and-a-long-flag '.repeat(8)}server.js`
    return `${Array.from(
      { length: processCount },
      (_, index) => `${1000 + index} 1 ${1000 + index} ${1000 + index} S+ ${argv}`
    ).join('\n')}\n`
  }

  it('reads a busy host whose table overflows execFile 1MB default', async () => {
    const table = busyHostTable(4_000)
    expect(Buffer.byteLength(table, 'utf-8')).toBeGreaterThan(NODE_DEFAULT_MAX_BUFFER_BYTES)
    mockPsWithNodeBufferSemantics(table)

    // Default maxBuffer rejects on busy hosts, making every capture unverifiable until load falls.
    await expect(getProcessTableSnapshot()).resolves.toHaveLength(4_000)
  })

  it('reports a truncated capture as unreadable rather than a silently short table', async () => {
    const table = busyHostTable(200)
    const truncated = table + 'x'.repeat(PS_MAX_BUFFER_BYTES - table.length)
    // The lenient parser accepts truncated rows; strict capture checks must reject partial tables instead of falsely proving no agent.
    expect(parseProcessTableRows(truncated)).toHaveLength(200)
    execFileMock.mockImplementation(
      (_command: string, _args: string[], _options: unknown, callback: unknown) => {
        ;(callback as (err: unknown, result: { stdout: string; stderr: string }) => void)(null, {
          stdout: truncated,
          stderr: ''
        })
      }
    )

    await expect(getProcessTableSnapshot()).rejects.toThrow(ProcessTableCaptureError)
    await expect(getProcessTableSnapshot()).rejects.toThrow('capture_truncated')
  })

  it('names a buffer-ceiling rejection as truncation on both views', async () => {
    mockPsWithNodeBufferSemantics('x'.repeat(PS_MAX_BUFFER_BYTES + 1))

    await expect(getProcessTableSnapshot()).rejects.toThrow('capture_truncated')
    resetProcessTableSnapshotForTests()
    await expect(getStrictProcessTableSnapshot()).rejects.toThrow('capture_truncated')
  })

  it('reports an empty capture as unreadable rather than an empty process table', async () => {
    // An empty table cannot describe a host running ps; lenient [] previously claimed absence.
    execFileMock.mockImplementation(
      (_command: string, _args: string[], _options: unknown, callback: unknown) => {
        ;(callback as (err: unknown, result: { stdout: string; stderr: string }) => void)(null, {
          stdout: '   \n',
          stderr: ''
        })
      }
    )

    await expect(getProcessTableSnapshot()).rejects.toThrow(ProcessTableCaptureError)
    await expect(getProcessTableSnapshot()).rejects.toThrow('empty_capture')
  })

  /** Emulate Node timeout SIGTERM/callback with empty stderr; otherwise a too-short budget looks identical to broken ps. */
  function mockPsTakingMs(durationMs: number, stdout: string): void {
    execFileMock.mockImplementation(
      (command: string, args: string[], options: unknown, callback: unknown) => {
        const done = callback as (err: unknown, result: { stdout: string; stderr: string }) => void
        const timeout = (options as { timeout?: number })?.timeout
        if (timeout !== undefined && durationMs > timeout) {
          const error = Object.assign(
            new Error(`Command failed: ${[command, ...args].join(' ')}\n`),
            { code: null, killed: true, signal: 'SIGTERM' }
          )
          done(error, { stdout: '', stderr: '' })
          return
        }
        done(null, { stdout, stderr: '' })
      }
    )
  }

  it('reads a loaded host whose whole-machine ps runs for seconds', async () => {
    // Measured command= costs 1.15s idle and up to 6s at load 27; 3s killed 6/20 otherwise readable captures.
    mockPsTakingMs(6_000, busyHostTable(200))

    expect(PS_TIMEOUT_MS).toBeGreaterThan(6_000)
    await expect(getProcessTableSnapshot()).resolves.toHaveLength(200)
  })

  it('still bounds a ps that never returns', async () => {
    mockPsTakingMs(PS_TIMEOUT_MS + 1, busyHostTable(200))

    await expect(getProcessTableSnapshot()).rejects.toThrow('Command failed: ps')
  })
})

/** Evidence freshness has a shorter budget than identity proof: stale observations return prompt unverifiable;
 * identity probes wait PS_TIMEOUT_MS because slow captures cannot prove process absence. */
describe('evidence-publishing capture budget', () => {
  beforeEach(() => {
    execFileMock.mockReset()
    resetProcessTableSnapshotForTests()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  /** A `ps` that answers after `durationMs` of wall clock, the way a loaded host does. */
  function mockPsTaking(
    durationMs: number,
    stdout = `1 0 1 1 S+ ${process.platform === 'darwin' ? '??' : '?'} Thu Jan 1 00:00:00 2026 bash\n`
  ) {
    execFileMock.mockImplementation(
      (_command: string, _args: string[], _options: unknown, callback: unknown) => {
        const done = callback as (err: unknown, result: { stdout: string; stderr: string }) => void
        setTimeout(() => done(null, { stdout, stderr: '' }), durationMs)
      }
    )
  }

  it('answers from a capture that lands one tick inside the budget', async () => {
    mockPsTaking(PROCESS_TABLE_EVIDENCE_BUDGET_MS - 1)
    const pending = getStrictProcessTableSnapshotWithAge()
    const settled = pending.catch(() => undefined)

    await vi.advanceTimersByTimeAsync(PROCESS_TABLE_EVIDENCE_BUDGET_MS)
    await settled

    // Capture duration counts against 2s freshness; this budget must be far below the identity timeout.
    expect((await pending).capturedAgeMs).toBe(PROCESS_TABLE_EVIDENCE_BUDGET_MS - 1)
  })

  it('gives up on a capture one tick past the budget instead of waiting out PS_TIMEOUT_MS', async () => {
    mockPsTaking(PROCESS_TABLE_EVIDENCE_BUDGET_MS + 1)
    const pending = getStrictProcessTableSnapshotWithAge()
    const settled = pending.then(
      () => 'resolved',
      (error: Error) => error.message
    )

    await vi.advanceTimersByTimeAsync(PROCESS_TABLE_EVIDENCE_BUDGET_MS)

    expect(await settled).toContain('process table unreadable')
  })

  it('leaves the abandoned capture running to fill the cache for the next reader', async () => {
    // Loaded hosts cannot afford a second whole-machine ps; abandoned shared captures must keep filling the cache.
    mockPsTaking(PROCESS_TABLE_EVIDENCE_BUDGET_MS + 100)
    const abandoned = getStrictProcessTableSnapshotWithAge().catch(() => null)

    await vi.advanceTimersByTimeAsync(PROCESS_TABLE_EVIDENCE_BUDGET_MS)
    expect(await abandoned).toBeNull()

    await vi.advanceTimersByTimeAsync(100)
    expect(await getStrictProcessTableSnapshotWithAge()).toMatchObject({
      capturedAgeMs: PROCESS_TABLE_EVIDENCE_BUDGET_MS + 100
    })
    expect(execFileMock).toHaveBeenCalledTimes(1)
  })
})
