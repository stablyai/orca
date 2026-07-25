import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  PtyStartupIngress,
  parsePtyStartupIngressIntent,
  type PtyIngressEmission
} from './pty-startup-ingress'

const COLORS = { foreground: '#2e3434', background: '#ffffff' }

function createHarness(options: { projection?: boolean; nested?: (data: string) => void } = {}) {
  const emissions: PtyIngressEmission[] = []
  let ingress!: PtyStartupIngress
  const writes: string[] = []
  ingress = new PtyStartupIngress({
    intent: {
      colors: COLORS,
      deadlineMs: 5_000
    },
    ...(options.projection ? { ownerBackend: 'windows-conpty' as const } : {}),
    write: (data) => {
      writes.push(data)
      options.nested?.(data)
    },
    onEmission: (emission) => emissions.push(emission)
  })
  return { ingress, writes, emissions }
}

function visible(emissions: readonly PtyIngressEmission[]): string {
  return emissions.map((emission) => emission.data).join('')
}

describe('PtyStartupIngress', () => {
  afterEach(() => vi.useRealTimers())

  it('validates intent colors and deadline bounds', () => {
    const intent = {
      colors: COLORS,
      deadlineMs: 5_000
    }
    expect(parsePtyStartupIngressIntent(intent)).toEqual(intent)
    expect(parsePtyStartupIngressIntent({ ...intent, deadlineMs: 30_001 })).toBeUndefined()
  })

  it('recognizes BEL/ST queries at every split and emits canonical replies', () => {
    const query = '\x1b]10;?\x07\x1b]11;?\x1b\\'
    for (let split = 0; split <= query.length; split += 1) {
      const { ingress, writes, emissions } = createHarness()
      ingress.accept(query.slice(0, split))
      ingress.accept(query.slice(split))
      ingress.drainAndClose()
      expect(visible(emissions), `split ${split}`).toBe('')
      expect(writes, `split ${split}`).toEqual([
        '\x1b]10;rgb:2e2e/3434/3434\x1b\\',
        '\x1b]11;rgb:ffff/ffff/ffff\x1b\\'
      ])
      expect(emissions.reduce((sum, item) => sum + item.rawEndSeq - item.rawStartSeq, 0)).toBe(
        query.length
      )
    }
  })

  it('suppresses the first echo immediately and keeps a later exact collision', () => {
    const { ingress, emissions } = createHarness({ projection: true })
    ingress.accept('\x1b]10;?\x07')
    const projected = ']10;rgb:2e2e/3434/3434\\'
    ingress.accept(projected)
    ingress.accept(projected)
    ingress.drainAndClose()
    expect(visible(emissions)).toBe(projected)
  })

  it('matches each echo across every split without skipping an earlier FIFO candidate', () => {
    const foregroundEcho = ']10;rgb:2e2e/3434/3434\\'
    const backgroundEcho = ']11;rgb:ffff/ffff/ffff\\'
    for (const projected of [foregroundEcho, backgroundEcho]) {
      for (let split = 0; split <= projected.length; split += 1) {
        const { ingress, emissions } = createHarness({ projection: true })
        ingress.accept(projected === foregroundEcho ? '\x1b]10;?\x07' : '\x1b]11;?\x1b\\')
        ingress.accept(projected.slice(0, split))
        ingress.accept(projected.slice(split))
        ingress.drainAndClose()
        expect(visible(emissions), `${projected.slice(0, 3)} split ${split}`).toBe('')
      }
    }

    const fifo = createHarness({ projection: true })
    fifo.ingress.accept('\x1b]10;?;?\x1b\\')
    fifo.ingress.accept(backgroundEcho)
    fifo.ingress.accept(backgroundEcho)
    fifo.ingress.drainAndClose()
    expect(visible(fifo.emissions)).toBe(backgroundEcho)
  })

  it('releases partial echo bytes on mismatch, timeout, and snapshot barrier', () => {
    vi.useFakeTimers()
    const mismatch = createHarness({ projection: true })
    mismatch.ingress.accept('\x1b]10;?\x07')
    mismatch.ingress.accept(']10;rgb:2e2e/nope')
    expect(visible(mismatch.emissions)).toBe(']10;rgb:2e2e/nope')

    const timeout = createHarness({ projection: true })
    timeout.ingress.accept('\x1b]10;?\x07')
    timeout.ingress.accept(']10;rgb:2e2e/')
    vi.advanceTimersByTime(5_000)
    expect(visible(timeout.emissions)).toBe(']10;rgb:2e2e/')

    const snapshot = createHarness({ projection: true })
    snapshot.ingress.accept('\x1b]10;?\x07')
    snapshot.ingress.accept(']10;rgb:2e2e/')
    snapshot.ingress.snapshotBarrier()
    expect(visible(snapshot.emissions)).toBe(']10;rgb:2e2e/')

    snapshot.ingress.accept('\x1b]11;?\x07')
    expect(snapshot.writes.at(-1)).toBe('\x1b]11;rgb:ffff/ffff/ffff\x1b\\')
  })

  it('serializes a synchronous nested provider callback after the consumed query span', () => {
    const emissions: PtyIngressEmission[] = []
    let ingress!: PtyStartupIngress
    ingress = new PtyStartupIngress({
      intent: { colors: COLORS, deadlineMs: 5_000 },
      write: () => ingress.accept('nested'),
      onEmission: (emission) => emissions.push(emission)
    })
    ingress.accept('before\x1b]10;?\x07after')
    ingress.drainAndClose()
    expect(emissions.map(({ data, transformed }) => ({ data, transformed }))).toEqual([
      { data: 'before', transformed: false },
      { data: '', transformed: true },
      { data: 'after', transformed: false },
      { data: 'nested', transformed: false }
    ])
  })

  it('releases an unanswerable native ConPTY color query to the downstream responder at every split', () => {
    // Why: bundled ConPTY forwards the query instead of answering it. Consuming a query this
    // transaction cannot answer leaves the agent with the pseudoconsole palette (#0c0c0c).
    const query = '\x1b]11;?\x1b\\'
    for (let split = 0; split <= query.length; split += 1) {
      const writes: string[] = []
      const emissions: PtyIngressEmission[] = []
      const ingress = new PtyStartupIngress({
        ownerBackend: 'windows-conpty',
        write: (data) => writes.push(data),
        onEmission: (emission) => emissions.push(emission)
      })
      ingress.closeQueryAuthority()
      ingress.accept(query.slice(0, split))
      ingress.accept(query.slice(split))
      ingress.drainAndClose()

      expect(writes, `split ${split}`).toEqual([])
      expect(visible(emissions), `split ${split}`).toBe(query)
    }
  })

  it('transfers native ConPTY authority on close and after the startup deadline', () => {
    vi.useFakeTimers()
    const closeWrites: string[] = []
    const closeEmissions: PtyIngressEmission[] = []
    const closed = new PtyStartupIngress({
      intent: { colors: COLORS, deadlineMs: 5_000 },
      ownerBackend: 'windows-conpty',
      write: (data) => closeWrites.push(data),
      onEmission: (emission) => closeEmissions.push(emission)
    })

    closed.accept('\x1b]10;')
    closed.closeQueryAuthority()
    closed.accept('?\x07')

    expect(closeWrites).toEqual([])
    expect(visible(closeEmissions)).toBe('\x1b]10;?\x07')

    const lateWrites: string[] = []
    const lateEmissions: PtyIngressEmission[] = []
    const late = new PtyStartupIngress({
      intent: { colors: COLORS, deadlineMs: 5_000 },
      ownerBackend: 'windows-conpty',
      write: (data) => lateWrites.push(data),
      onEmission: (emission) => lateEmissions.push(emission)
    })
    vi.advanceTimersByTime(5_001)
    late.accept('\x1b]11;?\x1b\\')

    expect(lateWrites).toEqual([])
    expect(visible(lateEmissions)).toBe('\x1b]11;?\x1b\\')
  })

  it('releases a native ConPTY query the transaction already answered once', () => {
    const writes: string[] = []
    const emissions: PtyIngressEmission[] = []
    const ingress = new PtyStartupIngress({
      intent: { colors: COLORS, deadlineMs: 5_000 },
      ownerBackend: 'windows-conpty',
      write: (data) => writes.push(data),
      onEmission: (emission) => emissions.push(emission)
    })

    ingress.accept('\x1b]10;?\x1b\\\x1b]11;?\x1b\\')
    emissions.length = 0
    ingress.accept('\x1b]11;?\x1b\\')

    expect(writes).toEqual(['\x1b]10;rgb:2e2e/3434/3434\x1b\\', '\x1b]11;rgb:ffff/ffff/ffff\x1b\\'])
    expect(visible(emissions)).toBe('\x1b]11;?\x1b\\')
  })

  it('releases a split native ConPTY query losslessly across close, expiry, and snapshot barriers', () => {
    vi.useFakeTimers()
    for (const barrier of ['close', 'expire', 'snapshot'] as const) {
      const emissions: PtyIngressEmission[] = []
      const ingress = new PtyStartupIngress({
        ...(barrier === 'expire' ? { intent: { colors: COLORS, deadlineMs: 5_000 } } : {}),
        ownerBackend: 'windows-conpty',
        write: () => {},
        onEmission: (emission) => emissions.push(emission)
      })
      ingress.accept('\x1b]10;')
      if (barrier === 'close') {
        ingress.closeQueryAuthority()
      } else if (barrier === 'expire') {
        vi.advanceTimersByTime(5_000)
      } else {
        ingress.snapshotBarrier()
      }

      ingress.accept('?\x07')

      expect(visible(emissions), barrier).toBe('\x1b]10;?\x07')
    }

    const malformedEmissions: PtyIngressEmission[] = []
    const malformed = new PtyStartupIngress({
      ownerBackend: 'windows-conpty',
      write: () => {},
      onEmission: (emission) => malformedEmissions.push(emission)
    })
    malformed.accept('\x1b]10;')
    malformed.snapshotBarrier()
    malformed.accept('not-a-query\x07')

    expect(visible(malformedEmissions)).toBe('\x1b]10;not-a-query\x07')
  })

  it('releases a partial query immediately when source authority closes', () => {
    const emissions: PtyIngressEmission[] = []
    const ingress = new PtyStartupIngress({
      intent: { colors: COLORS, deadlineMs: 5_000 },
      ownerBackend: 'posix-pty',
      write: () => {},
      onEmission: (emission) => emissions.push(emission)
    })

    ingress.accept('\x1b]10;')
    expect(emissions).toEqual([])
    ingress.closeQueryAuthority()

    expect(visible(emissions)).toBe('\x1b]10;')
  })

  it('keeps POSIX, WSL, malformed, and unrelated output unchanged', () => {
    const input = 'typed\x1b[A\x1b]12;?\x1b\\\x1b]10;not-a-query\x07'
    vi.useFakeTimers()
    for (const ownerBackend of ['posix-pty', 'windows-wsl'] as const) {
      const emissions: PtyIngressEmission[] = []
      const ingress = new PtyStartupIngress({
        ownerBackend,
        write: () => {},
        onEmission: (emission) => emissions.push(emission)
      })
      ingress.accept(`\x1b]10;?\x07${input}`)
      expect(visible(emissions)).toBe(`\x1b]10;?\x07${input}`)
    }

    const writes: string[] = []
    const emissions: PtyIngressEmission[] = []
    const nativeIngress = new PtyStartupIngress({
      intent: { colors: COLORS, deadlineMs: 5_000 },
      ownerBackend: 'windows-conpty',
      write: (data) => writes.push(data),
      onEmission: (emission) => emissions.push(emission)
    })
    vi.advanceTimersByTime(5_001)
    nativeIngress.accept(`${input}\x1b]10;?\x07`)

    expect(writes).toEqual([])
    expect(visible(emissions)).toBe(`${input}\x1b]10;?\x07`)
  })

  it('ignores callbacks after teardown without recreating the raw sequence domain', () => {
    const { ingress, emissions } = createHarness({ projection: true })
    ingress.accept('\x1b]10;?\x07')
    ingress.accept(']10;rgb:2e2e/')
    const closedAt = ingress.drainAndClose()
    ingress.accept('late')
    expect(ingress.acceptedRawSequence).toBe(closedAt)
    expect(visible(emissions)).toBe(']10;rgb:2e2e/')
  })
})
