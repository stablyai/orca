// Why: pins the fold key and the run-duration bookkeeping. A status-only key or
// a `lastRecorded` map that outlives its ring silently deletes (or fabricates)
// the reconnect history the diagnostic report exists to show.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getHeapSnapshot } from 'node:v8'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SshConnectionState, SshConnectionStatus } from '../../../shared/ssh-types'
import { MAX_SCRUB_INPUT_CHARS } from './ssh-diagnostic-text-scrub'
import type * as SshStatusTimelineModule from './ssh-status-timeline'

type TimelineModule = typeof SshStatusTimelineModule

const HOUR_MS = 3_600_000

// Read rather than import: the renderer tsconfig project cannot pull in main
// (TS6307), and a hand-copied ladder would drift from the real backoff table.
function readReconnectBackoffMs(): number[] {
  const source = readFileSync(join(process.cwd(), 'src/main/ssh/ssh-connection-utils.ts'), 'utf8')
  const table = /export const RECONNECT_BACKOFF_MS = \[([^\]]+)\]/.exec(source)?.[1]
  if (table === undefined) {
    throw new Error('RECONNECT_BACKOFF_MS literal not found in ssh-connection-utils.ts')
  }
  return table.split(',').map((entry) => Number(entry.trim()))
}

const RECONNECT_BACKOFF_MS = readReconnectBackoffMs()

function sshState(overrides: Partial<SshConnectionState> = {}): SshConnectionState {
  return {
    targetId: 'target-1',
    status: 'connected',
    error: null,
    reconnectAttempt: 0,
    ...overrides
  }
}

describe('ssh status timeline', () => {
  let timeline: TimelineModule

  // The module holds process-wide Maps, so each case needs a fresh instance.
  beforeEach(async () => {
    vi.resetModules()
    vi.useFakeTimers()
    vi.setSystemTime(1_700_000_000_000)
    timeline = await import('./ssh-status-timeline')
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.doUnmock('../../../shared/pty-delivery-diagnostics')
  })

  it('stays bounded at the inherited 100-entry ring capacity', () => {
    const statuses: SshConnectionStatus[] = ['connected', 'disconnected', 'reconnecting', 'error']
    for (let i = 0; i < 150; i++) {
      vi.advanceTimersByTime(1_000)
      timeline.recordSshStateArrival(
        'target-1',
        sshState({ status: statuses[i % statuses.length], reconnectAttempt: i }),
        'push'
      )
    }

    const entries = timeline.snapshotSshStatusTimeline('target-1')
    expect(entries).toHaveLength(100)
    expect(entries[0].attempt).toBe(50)
    expect(entries[99].attempt).toBe(149)
  })

  it('folds a slow flap into one entry without evicting the original drop', () => {
    timeline.recordSshStateArrival('target-1', sshState({ status: 'connected' }), 'push')
    vi.advanceTimersByTime(60_000)
    timeline.recordSshStateArrival(
      'target-1',
      sshState({ status: 'disconnected', error: 'socket closed' }),
      'push'
    )
    for (let i = 0; i < 200; i++) {
      vi.advanceTimersByTime(HOUR_MS)
      timeline.recordSshStateArrival(
        'target-1',
        sshState({ status: 'reconnecting', reconnectAttempt: 1 }),
        'push'
      )
    }

    const entries = timeline.snapshotSshStatusTimeline('target-1')
    expect(entries.map((entry) => entry.status)).toEqual([
      'connected',
      'disconnected',
      'reconnecting'
    ])
    expect(entries[2].repeats).toBe(200)
    expect(entries[2].runMs).toBe(199 * HOUR_MS)
  })

  it('does not fold an alternating reconnecting/connected flap', () => {
    for (let i = 0; i < 3; i++) {
      vi.advanceTimersByTime(1_000)
      timeline.recordSshStateArrival(
        'target-1',
        sshState({ status: 'reconnecting', reconnectAttempt: 1 }),
        'push'
      )
      vi.advanceTimersByTime(1_000)
      timeline.recordSshStateArrival('target-1', sshState({ status: 'connected' }), 'push')
    }

    const entries = timeline.snapshotSshStatusTimeline('target-1')
    expect(entries.map((entry) => entry.status)).toEqual([
      'reconnecting',
      'connected',
      'reconnecting',
      'connected',
      'reconnecting',
      'connected'
    ])
    expect(entries.every((entry) => entry.repeats === 1)).toBe(true)
  })

  it('reports runMs from the run start even though the ring restamps atMs', () => {
    const start = Date.now()
    const arrival = sshState({ status: 'reconnecting', reconnectAttempt: 2 })
    timeline.recordSshStateArrival('target-1', arrival, 'push')
    vi.advanceTimersByTime(1_000)
    timeline.recordSshStateArrival('target-1', arrival, 'push')
    vi.advanceTimersByTime(5_000)
    timeline.recordSshStateArrival('target-1', arrival, 'push')

    const entries = timeline.snapshotSshStatusTimeline('target-1')
    expect(entries).toHaveLength(1)
    expect(entries[0].atMs).toBe(start + 6_000)
    expect(entries[0].runMs).toBe(6_000)
  })

  it('caps a raw error at 2048 chars when recording', () => {
    timeline.recordSshStateArrival(
      'target-1',
      sshState({ status: 'error', error: 'x'.repeat(5_000) }),
      'push'
    )

    expect(timeline.snapshotSshStatusTimeline('target-1')[0].error).toHaveLength(2_048)
  })

  // Nothing else couples the two bounds. If the record cap ever exceeds the
  // scrub's input bound, capture cuts an already-cut error a second time and
  // the `-----END` this cap preserves is stranded after all.
  it('records inside the scrub input bound', () => {
    expect(timeline.RAW_ERROR_CHARS).toBeLessThanOrEqual(MAX_SCRUB_INPUT_CHARS)
  })

  // Head-only truncation strands the head of a key: the PEM rule is anchored on
  // `-----END`, so a preamble long enough to push the terminator past the cap
  // would leave the whole block for the capture-side scrub to miss.
  it('keeps both ends of an over-long error so the PEM terminator survives', () => {
    const key = `-----BEGIN OPENSSH PRIVATE KEY-----\n${'k'.repeat(400)}\n-----END OPENSSH PRIVATE KEY-----`
    timeline.recordSshStateArrival(
      'target-1',
      sshState({ status: 'error', error: `${'preamble '.repeat(400)}${key}` }),
      'push'
    )

    const recorded = timeline.snapshotSshStatusTimeline('target-1')[0].error ?? ''
    expect(recorded).toContain('-----END OPENSSH PRIVATE KEY-----')
    expect(recorded.length).toBeLessThanOrEqual(2_048)
  })

  // The cap above bounds the reported LENGTH either way: `.slice()` hands back a
  // V8 SlicedString that keeps the whole parent error alive, so a value
  // assertion passes with every byte of the original still retained.
  // Explicit timeout: two full heap walks are legitimately slow, and the default
  // 5s makes a slow-but-passing run read as an intermittent failure.
  it('does not retain the parent of the error it caps', { timeout: 60_000 }, async () => {
    vi.useRealTimers()
    const PARENT_CHARS = 400_000
    const ARRIVALS = 40

    // getHeapSnapshot runs a full GC before it walks, so this needs no --expose-gc.
    const heapUsedAfterGc = async (): Promise<number> => {
      await new Promise<void>((resolve, reject) => {
        const stream = getHeapSnapshot()
        stream.on('data', () => {})
        // Reject rather than hang: a failed walk never emits `end`.
        stream.on('error', reject)
        stream.on('end', () => resolve())
      })
      return process.memoryUsage().heapUsed
    }

    const before = await heapUsedAfterGc()
    for (let i = 0; i < ARRIVALS; i++) {
      timeline.recordSshStateArrival(
        'target-1',
        sshState({
          status: 'error',
          error: `${'x'.repeat(PARENT_CHARS)}-${i}`,
          reconnectAttempt: i
        }),
        'push'
      )
    }
    const after = await heapUsedAfterGc()

    expect(timeline.snapshotSshStatusTimeline('target-1')).toHaveLength(ARRIVALS)
    // Pinned parents cost ARRIVALS * PARENT_CHARS ≈ 16 MB; flat copies cost ~160 KB.
    expect(after - before).toBeLessThan(4 * 1024 * 1024)
  })

  // Reconciliation corrects the authority of a state already recorded. With
  // generation out of the fold key it lands as a `repeats` bump on that entry,
  // and repeats/runMs are the flap signal the report is read for.
  it('does not fold an authority correction into the arrival it corrects', () => {
    timeline.recordSshStateArrival('target-1', sshState({ status: 'connected' }), 'push')
    vi.advanceTimersByTime(300)
    timeline.recordSshStateArrival(
      'target-1',
      sshState({ status: 'connected', connectionGeneration: 5 }),
      'reconciliation'
    )

    expect(timeline.snapshotSshStatusTimeline('target-1')).toEqual([
      expect.objectContaining({
        status: 'connected',
        generation: null,
        origin: 'push',
        repeats: 1
      }),
      expect.objectContaining({
        status: 'connected',
        generation: 5,
        origin: 'reconciliation',
        repeats: 1,
        runMs: null
      })
    ])
  })

  it('scopes rings by environment so one host cannot write another host timeline', () => {
    timeline.recordSshStateArrival('target-1', sshState({ status: 'connected' }), 'push')
    vi.advanceTimersByTime(1_000)
    timeline.recordSshStateArrival(
      'target-1',
      sshState({ status: 'error', error: 'remote host refused' }),
      'runtime-push',
      'env-1'
    )

    expect(timeline.snapshotSshStatusTimeline('target-1').map((entry) => entry.status)).toEqual([
      'connected'
    ])
    expect(
      timeline.snapshotSshStatusTimeline('target-1', 'env-1').map((entry) => entry.status)
    ).toEqual(['error'])
  })

  // A forced re-hydration re-inserts every target it reads, so with one global
  // budget the sweep order IS the LRU order and the ring being captured dies.
  it('sheds inside the sweeping environment rather than the local ring', () => {
    const arrival = sshState({ status: 'reconnecting', reconnectAttempt: 1 })
    const sweepSize = timeline.MAX_TARGETS * 2
    timeline.recordSshStateArrival('target-1', arrival, 'push')
    for (let i = 0; i < sweepSize; i++) {
      vi.advanceTimersByTime(1_000)
      timeline.recordSshStateArrival(`env-target-${i}`, arrival, 'runtime-hydration', 'env-1')
    }

    expect(timeline.snapshotSshStatusTimeline('target-1')).toHaveLength(1)
    expect(timeline.snapshotSshStatusTimeline(`env-target-${sweepSize - 1}`, 'env-1')).toHaveLength(
      1
    )
  })

  // The inverse of the case above, and the one a scope-first eviction got
  // backwards: a full map of stale local rings must not pin the environment
  // that is actively failing at a single ring.
  it('sheds stale local rings rather than starving a late-arriving environment', () => {
    const arrival = sshState({ status: 'reconnecting', reconnectAttempt: 1 })
    for (let i = 0; i < timeline.MAX_TARGETS; i++) {
      vi.advanceTimersByTime(1_000)
      timeline.recordSshStateArrival(`local-${i}`, arrival, 'initial-hydration')
    }
    for (let i = 0; i < 8; i++) {
      vi.advanceTimersByTime(1_000)
      timeline.recordSshStateArrival(`env-target-${i}`, arrival, 'runtime-push', 'env-1')
    }

    expect(
      Array.from({ length: 8 }, (_, i) =>
        timeline.snapshotSshStatusTimeline(`env-target-${i}`, 'env-1')
      ).map((entries) => entries.length)
    ).toEqual([1, 1, 1, 1, 1, 1, 1, 1])
  })

  // Scope fairness answers a flood concentrated in ONE scope; a wake-from-sleep
  // is the other shape — every configured target flaps once, at once. The cap
  // used to sit below a realistic target count, so the oldest rings shed and the
  // pane whose overlay surfaced first (the one the user clicks) captured nothing.
  it('keeps every ring through a simultaneous flap of a realistic target count', () => {
    const arrival = sshState({ status: 'reconnecting', reconnectAttempt: 1 })
    const WAKE_TARGETS = 60

    for (let i = 0; i < WAKE_TARGETS; i++) {
      vi.advanceTimersByTime(10)
      timeline.recordSshStateArrival(`local-${i}`, arrival, 'push')
    }

    expect(WAKE_TARGETS).toBeLessThanOrEqual(timeline.MAX_TARGETS)
    expect(timeline.snapshotSshStatusTimeline('local-0')).toHaveLength(1)
    expect(timeline.snapshotSshStatusTimeline('local-11')).toHaveLength(1)
  })

  // Copy-diagnostics is a read, and a read that leaves its own ring at the head
  // of the eviction queue hands the next capture `Timeline: 0 entries`.
  it('keeps the ring it just captured out of the next eviction', () => {
    const arrival = sshState({ status: 'reconnecting', reconnectAttempt: 1 })
    for (let i = 0; i < timeline.MAX_TARGETS; i++) {
      vi.advanceTimersByTime(1_000)
      timeline.recordSshStateArrival(`local-${i}`, arrival, 'push')
    }
    expect(timeline.snapshotSshStatusTimeline('local-0')).toHaveLength(1)

    vi.advanceTimersByTime(1_000)
    timeline.recordSshStateArrival('local-late', arrival, 'push')

    expect(timeline.snapshotSshStatusTimeline('local-0')).toHaveLength(1)
    expect(timeline.snapshotSshStatusTimeline('local-1')).toEqual([])
  })

  // Environment ids are opaque strings. An unescaped one containing `::` forges
  // the scope boundary, so its lone ring is counted into — and evicted with —
  // the sweeping neighbour it merely shares a prefix with.
  it('does not let an environment id containing the separator forge a scope', () => {
    const arrival = sshState({ status: 'connected' })
    timeline.recordSshStateArrival('target-1', arrival, 'runtime-push', 'env::a')
    for (let i = 0; i <= timeline.MAX_TARGETS; i++) {
      vi.advanceTimersByTime(1_000)
      timeline.recordSshStateArrival(`target-${i}`, arrival, 'runtime-hydration', 'env')
    }

    expect(timeline.snapshotSshStatusTimeline('target-1', 'env::a')).toHaveLength(1)
  })

  // `scopeOf` is the only thing keeping one host's ring out of another's, so the
  // two inputs it could once map onto the same key are pinned here.
  it('keeps an environment named like the local scope out of the local ring', () => {
    timeline.recordSshStateArrival('target-1', sshState({ status: 'connected' }), 'push')
    vi.advanceTimersByTime(1_000)
    timeline.recordSshStateArrival(
      'target-1',
      sshState({ status: 'error', error: 'remote host refused' }),
      'runtime-push',
      'local'
    )

    expect(timeline.snapshotSshStatusTimeline('target-1').map((entry) => entry.status)).toEqual([
      'connected'
    ])
    expect(
      timeline.snapshotSshStatusTimeline('target-1', 'local').map((entry) => entry.status)
    ).toEqual(['error'])
  })

  it('does not merge an environment id with the escaped form of another', () => {
    timeline.recordSshStateArrival(
      'target-1',
      sshState({ status: 'connected' }),
      'runtime-push',
      'a:b'
    )
    vi.advanceTimersByTime(1_000)
    timeline.recordSshStateArrival(
      'target-1',
      sshState({ status: 'error', error: 'remote host refused' }),
      'runtime-push',
      'a%3Ab'
    )

    expect(
      timeline.snapshotSshStatusTimeline('target-1', 'a:b').map((entry) => entry.status)
    ).toEqual(['connected'])
    expect(
      timeline.snapshotSshStatusTimeline('target-1', 'a%3Ab').map((entry) => entry.status)
    ).toEqual(['error'])
  })

  // A rehydration sweep re-reads states that never re-arrived; counting those
  // would inflate the repeats/runMs the report is read for.
  it('does not fold a hydration re-read into the arrival it re-reads', () => {
    const arrival = sshState({ status: 'reconnecting', reconnectAttempt: 2 })
    timeline.recordSshStateArrival('target-1', arrival, 'runtime-push', 'env-1')
    vi.advanceTimersByTime(1_000)
    timeline.recordSshStateArrival('target-1', arrival, 'runtime-hydration', 'env-1')

    expect(timeline.snapshotSshStatusTimeline('target-1', 'env-1')).toEqual([
      expect.objectContaining({ status: 'reconnecting', repeats: 1, runMs: null })
    ])
  })

  // A backwards system clock is the only way `now` precedes the run start.
  it('never reports a negative run duration', () => {
    const arrival = sshState({ status: 'reconnecting', reconnectAttempt: 1 })
    timeline.recordSshStateArrival('target-1', arrival, 'push')
    vi.setSystemTime(Date.now() - 30_000)
    timeline.recordSshStateArrival('target-1', arrival, 'push')

    expect(timeline.snapshotSshStatusTimeline('target-1')[0].runMs).toBe(0)
  })

  it('decodes status and attempt back out of the encoded kind', () => {
    timeline.recordSshStateArrival(
      'target-1',
      sshState({ status: 'connected', connectionGeneration: 7 }),
      'initial-hydration'
    )
    vi.advanceTimersByTime(1_000)
    timeline.recordSshStateArrival(
      'target-1',
      sshState({ status: 'reconnecting', reconnectAttempt: 3, error: 'relay lost' }),
      'runtime-push'
    )

    expect(timeline.snapshotSshStatusTimeline('target-1')).toEqual([
      {
        atMs: expect.any(Number),
        status: 'connected',
        attempt: 0,
        repeats: 1,
        runMs: null,
        error: null,
        generation: 7,
        origin: 'initial-hydration'
      },
      {
        atMs: expect.any(Number),
        status: 'reconnecting',
        attempt: 3,
        repeats: 1,
        runMs: null,
        error: 'relay lost',
        generation: null,
        origin: 'runtime-push'
      }
    ])
  })

  // This is what keeps the fold key `(status, attempt)`: a status-only key passes
  // every other case here and collapses this ladder into one entry.
  it('never folds a distinct reconnect attempt away', () => {
    expect(RECONNECT_BACKOFF_MS).toHaveLength(9)
    RECONNECT_BACKOFF_MS.forEach((backoffMs, index) => {
      vi.advanceTimersByTime(backoffMs)
      timeline.recordSshStateArrival(
        'target-1',
        sshState({
          status: 'reconnecting',
          reconnectAttempt: index + 1,
          error: `attempt ${index + 1} refused`
        }),
        'push'
      )
    })

    const entries = timeline.snapshotSshStatusTimeline('target-1')
    expect(entries).toHaveLength(9)
    expect(entries.map((entry) => entry.attempt)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect(entries.map((entry) => entry.error)).toEqual(
      RECONNECT_BACKOFF_MS.map((_, index) => `attempt ${index + 1} refused`)
    )
    expect(entries.every((entry) => entry.status === 'reconnecting' && entry.repeats === 1)).toBe(
      true
    )
  })

  it('drops lastRecorded with the ring when LRU evicts a target', () => {
    const arrival = sshState({ status: 'reconnecting', reconnectAttempt: 1 })
    timeline.recordSshStateArrival('target-0', arrival, 'push')
    vi.advanceTimersByTime(1_000)
    timeline.recordSshStateArrival('target-0', arrival, 'push')
    expect(timeline.snapshotSshStatusTimeline('target-0')[0].runMs).toBe(1_000)

    for (let i = 1; i <= timeline.MAX_TARGETS; i++) {
      vi.advanceTimersByTime(1_000)
      timeline.recordSshStateArrival(`target-${i}`, arrival, 'push')
    }
    expect(timeline.snapshotSshStatusTimeline('target-0')).toEqual([])

    vi.advanceTimersByTime(1_000)
    timeline.recordSshStateArrival('target-0', arrival, 'push')
    const entries = timeline.snapshotSshStatusTimeline('target-0')
    expect(entries).toHaveLength(1)
    expect(entries[0].runMs).toBeNull()
  })

  it('drops lastRecorded with the ring when a target is forgotten', () => {
    const arrival = sshState({ status: 'reconnecting', reconnectAttempt: 1 })
    timeline.recordSshStateArrival('target-1', arrival, 'push')
    vi.advanceTimersByTime(1_000)
    timeline.recordSshStateArrival('target-1', arrival, 'push')

    timeline.forgetSshStatusTimeline('target-1')
    expect(timeline.snapshotSshStatusTimeline('target-1')).toEqual([])

    vi.advanceTimersByTime(1_000)
    timeline.recordSshStateArrival('target-1', arrival, 'push')
    const entries = timeline.snapshotSshStatusTimeline('target-1')
    expect(entries).toHaveLength(1)
    expect(entries[0].runMs).toBeNull()
  })

  it('returns normally when the ring itself throws', async () => {
    vi.resetModules()
    vi.doMock('../../../shared/pty-delivery-diagnostics', () => ({
      createPtyDeliveryBreadcrumbRing: () => ({
        record: () => {
          throw new Error('ring exploded')
        },
        snapshot: () => {
          throw new Error('ring exploded')
        },
        reset: () => {}
      })
    }))
    const throwing = (await import('./ssh-status-timeline')) as TimelineModule

    expect(() =>
      throwing.recordSshStateArrival('target-1', sshState({ status: 'disconnected' }), 'push')
    ).not.toThrow()
    expect(throwing.snapshotSshStatusTimeline('target-1')).toEqual([])
  })
})
