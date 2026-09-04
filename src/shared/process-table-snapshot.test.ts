import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }))

vi.mock('node:child_process', () => ({ execFile: execFileMock }))

import {
  createProcessTableSnapshotReader,
  getProcessTableSnapshot,
  getStrictProcessTableSnapshot,
  PS_MAX_BUFFER_BYTES,
  resetProcessTableSnapshotForTests
} from './process-table-snapshot-reader'
import {
  parseProcessTableRows,
  parseStrictProcessTableRows,
  ProcessTableCaptureError
} from './process-table-snapshot'
import {
  buildProcessTableIndex,
  getProcessTableIndex,
  type ProcessTableIndexStats
} from './process-table-index'

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
    // Why: the in-flight promise is shared, so a burst of panes inspecting at
    // once forks `ps` exactly once.
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

    // capturedAt is stamped at now()=600, so a call at 900 is still within TTL.
    clock = 900
    expect(await reader.getSnapshot()).toBe('scan-1')
    expect(scans).toBe(1)
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
    // Why: a transient ps failure must not poison the cache — the next
    // inspection re-scans rather than returning a cached error.
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

  it('shares one parsed-rows array across a burst so panes do not each re-parse', async () => {
    // Mirrors the POSIX default reader: runPs parses inside the deduped scan, so
    // every caller in the TTL window gets the SAME ProcessTableRow[] instance
    // instead of re-tokenizing identical stdout per pane.
    let parses = 0
    const gate = deferred<ReturnType<typeof parseProcessTableRows>>()
    const reader = createProcessTableSnapshotReader<ReturnType<typeof parseProcessTableRows>>({
      runPs: () => {
        parses += 1
        return gate.promise
      },
      now: () => 0
    })

    const a = reader.getSnapshot()
    const b = reader.getSnapshot()
    gate.resolve(parseProcessTableRows('100 1 Ss+ /bin/zsh'))

    const rowsA = await a
    const rowsB = await b
    expect(parses).toBe(1)
    // Reference identity: the burst reuses one parse, not one-per-caller.
    expect(rowsA).toBe(rowsB)
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
    // Why: both views run byte-identical argv, so separate memoizers would double
    // the relay's idle fork rate — the regression issue #6288 removed.
    const forks = mockPsCaptures('100 1 100 100 Ss+ /bin/zsh\n', '200 1 200 200 Ss+ /bin/bash\n')

    const [lenient, strict] = await Promise.all([
      getProcessTableSnapshot(),
      getStrictProcessTableSnapshot()
    ])

    expect(forks()).toBe(1)
    expect(lenient.map((row) => row.pid)).toEqual([100])
    expect(strict.map((row) => row.pid)).toEqual([100])
  })

  it('reuses the cached capture for a later strict read inside the TTL', async () => {
    const forks = mockPsCaptures('100 1 100 100 Ss+ /bin/zsh\n', '200 1 200 200 Ss+ /bin/bash\n')

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
        command: '/bin/zsh'
      }
    ])
  })

  it('builds only the indexes a resolver reads', () => {
    // Why: an unread group index costs two maps plus a per-row array on every
    // capture, on the exact path this reader exists to make cheap.
    const index = buildProcessTableIndex(
      parseStrictProcessTableRows('100 1 100 101 Ss /bin/zsh\n101 100 101 101 S+ node /opt/codex')
    )

    expect(Object.keys(index).sort()).toEqual(['byPid', 'childrenByPpid', 'rows', 'stats'])
  })

  it('keeps the lenient view readable when the same capture is strictly unreadable', async () => {
    const forks = mockPsCaptures('100 1 Ss+ /bin/zsh\n')

    const lenient = await getProcessTableSnapshot()
    await expect(getStrictProcessTableSnapshot()).rejects.toBeInstanceOf(ProcessTableCaptureError)

    expect(forks()).toBe(1)
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
    // Preserve rows.find() semantics if a malformed table repeats a pid: an argv
    // newline makes `ps` print a continuation line that can parse as a spurious
    // row, and that row always follows the real one it was split from.
    const rows = parseProcessTableRows(['100 1 Ss bash', '100 1 Ss+ zsh'].join('\n'))

    expect(getProcessTableIndex(rows).byPid.get(100)).toBe(rows[0])
    expect(buildProcessTableIndex(rows).byPid.get(100)).toBe(rows[0])
  })

  it('materializes only the maps the descendant walk reads', () => {
    // Why: this memo exists to cut relay CPU; four indexes for two readers would
    // make a single-pane relay pay more per capture than the code it replaced.
    const index = getProcessTableIndex(parseProcessTableRows('100 1 Ss bash'))

    expect(Object.keys(index).sort()).toEqual(['byPid', 'childrenByPpid', 'rows', 'stats'])
  })

  it('keeps the memo out of measured builds so a cache hit cannot satisfy a perf gate', () => {
    const rows = parseProcessTableRows('100 1 Ss bash')
    const stats: ProcessTableIndexStats = {
      indexBuilds: 0,
      rowVisits: 0,
      indexLookups: 0
    }

    const memoized = getProcessTableIndex(rows)
    const measured = buildProcessTableIndex(rows, stats)

    expect(memoized.stats).toBeUndefined()
    expect(measured).not.toBe(memoized)
    expect(stats).toEqual({ indexBuilds: 1, rowVisits: 1, indexLookups: 0 })
    // The measured build must not evict or replace the shared memo.
    expect(getProcessTableIndex(rows)).toBe(memoized)
  })
})

describe('process-table capture completeness', () => {
  const NODE_DEFAULT_MAX_BUFFER_BYTES = 1024 * 1024

  beforeEach(() => {
    execFileMock.mockReset()
    resetProcessTableSnapshotForTests()
  })

  /**
   * Emulate Node's own execFile buffering: over `maxBuffer` it kills the child and
   * calls back with ERR_CHILD_PROCESS_STDIO_MAXBUFFER plus the truncated bytes. A
   * mock that always resolves would hide the very ceiling under test.
   */
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

    // Without an explicit maxBuffer this rejects, so the whole subsystem degrades
    // to "unverifiable" on every capture for as long as the host stays busy.
    await expect(getProcessTableSnapshot()).resolves.toHaveLength(4_000)
  })

  it('reports a truncated capture as unreadable rather than a silently short table', async () => {
    const table = busyHostTable(200)
    const truncated = table + 'x'.repeat(PS_MAX_BUFFER_BYTES - table.length)
    // A capture that stopped at the ceiling but still resolved: the lenient parser
    // drops the cut tail without complaint, so 200 of N processes would read as
    // the complete list — a false "no agent" the execution boundary forbids.
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
    // The lenient view used to answer [] here: zero processes on a machine that is
    // by definition running at least `ps` itself.
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
})
