import { describe, expect, it } from 'vitest'
import { createProcessTableSnapshotReader, parseProcessTableRows } from './process-table-snapshot'

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

describe('parseProcessTableRows', () => {
  it('parses pid/ppid/stat and keeps the full command (including spaces)', () => {
    const rows = parseProcessTableRows(
      ['501 1 S /bin/zsh', '600 501 S+ node /path/bin/codex --flag'].join('\n')
    )
    expect(rows).toEqual([
      { pid: 501, ppid: 1, stat: 'S', command: '/bin/zsh' },
      { pid: 600, ppid: 501, stat: 'S+', command: 'node /path/bin/codex --flag' }
    ])
  })

  it('tolerates CRLF and skips header/blank/non-matching lines', () => {
    const rows = parseProcessTableRows('  PID PPID STAT COMMAND\r\n42 1 Ss /sbin/launchd\r\n\r\n')
    expect(rows).toEqual([{ pid: 42, ppid: 1, stat: 'Ss', command: '/sbin/launchd' }])
  })
})
