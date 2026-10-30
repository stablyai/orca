import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  PtyStartupIngress,
  parsePtyStartupIngressIntent,
  type PtyIngressEmission
} from './pty-startup-ingress'

const COLORS = { foreground: '#2e3434', background: '#ffffff' }
const FOREGROUND_REPLY = '\x1b]10;rgb:2e2e/3434/3434\x1b\\'
const BACKGROUND_REPLY = '\x1b]11;rgb:ffff/ffff/ffff\x1b\\'
// Orca's default dark theme, which answers until a viewer reports colours.
const DEFAULT_FOREGROUND_REPLY = '\x1b]10;rgb:ffff/ffff/ffff\x1b\\'
const DEFAULT_BACKGROUND_REPLY = '\x1b]11;rgb:2828/2c2c/3434\x1b\\'
// The two echo shapes a cooked POSIX tty produces for a written reply: ECHOCTL
// caret forms, and readline eating `ESC ]` / ST while self-inserting the rest.
const POSIX_COOKED_ECHOES = [
  (reply: string): string => reply.replaceAll('\x1b', '^['),
  (reply: string): string => reply.replaceAll('\x1b]', '\x07').replaceAll('\x1b\\', '')
]

function createHarness(
  options: {
    projection?: boolean
    nested?: (data: string) => void
  } = {}
) {
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

  it('recognizes BEL/ST queries at every split and answers both in order', () => {
    vi.useFakeTimers()
    const query = '\x1b]10;?\x07\x1b]11;?\x1b\\'
    for (let split = 0; split <= query.length; split += 1) {
      const { ingress, writes, emissions } = createHarness()
      ingress.accept(query.slice(0, split))
      ingress.accept(query.slice(split))
      // Answered in the accepting turn, in query order — no queue to reorder them.
      vi.advanceTimersByTime(0)
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
    vi.useFakeTimers()
    const emissions: PtyIngressEmission[] = []
    let ingress!: PtyStartupIngress
    ingress = new PtyStartupIngress({
      intent: { colors: COLORS, deadlineMs: 5_000 },
      write: () => ingress.accept('nested'),
      onEmission: (emission) => emissions.push(emission)
    })
    ingress.accept('before\x1b]10;?\x07after')
    vi.advanceTimersByTime(0)
    ingress.drainAndClose()
    expect(emissions.map(({ data, transformed }) => ({ data, transformed }))).toEqual([
      { data: 'before', transformed: false },
      { data: '', transformed: true },
      { data: 'after', transformed: false },
      { data: 'nested', transformed: false }
    ])
  })

  it('answers a ConPTY query with no known colours from the default theme at every split', () => {
    // #22332: this used to be swallowed with no reply, so Codex drew no message shading.
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

      expect(writes, `split ${split}`).toEqual([DEFAULT_BACKGROUND_REPLY])
      expect(visible(emissions), `split ${split}`).toBe('')
      expect(emissions, `split ${split}`).toEqual([
        { data: '', rawStartSeq: 0, rawEndSeq: query.length, transformed: true }
      ])
    }
  })

  it('keeps native ConPTY startup authority until it can answer with owner-supplied colors', () => {
    const writes: string[] = []
    const emissions: PtyIngressEmission[] = []
    const ingress = new PtyStartupIngress({
      intent: { colors: COLORS, deadlineMs: 5_000 },
      ownerBackend: 'windows-conpty',
      write: (data) => writes.push(data),
      onEmission: (emission) => emissions.push(emission)
    })

    ingress.accept('\x1b]10;')
    ingress.closeQueryAuthority()
    ingress.accept('?\x07')

    expect(writes).toEqual(['\x1b]10;rgb:2e2e/3434/3434\x1b\\'])
    expect(visible(emissions)).toBe('')
  })

  it('keeps a split native ConPTY query private across close, expiry, and snapshot barriers', () => {
    vi.useFakeTimers()
    for (const barrier of ['close', 'expire', 'snapshot'] as const) {
      const emissions: PtyIngressEmission[] = []
      const ingress = new PtyStartupIngress({
        // Why a short window: the torn query's own 500 ms hold must not be what ends it here.
        ...(barrier === 'expire' ? { intent: { colors: COLORS, deadlineMs: 100 } } : {}),
        ownerBackend: 'windows-conpty',
        write: () => {},
        onEmission: (emission) => emissions.push(emission)
      })
      ingress.accept('\x1b]10;')
      if (barrier === 'close') {
        ingress.closeQueryAuthority()
      } else if (barrier === 'expire') {
        vi.advanceTimersByTime(100)
      } else {
        ingress.snapshotBarrier()
      }
      expect(emissions, barrier).toEqual([])

      ingress.accept('?\x07')

      expect(visible(emissions), barrier).toBe('')
      expect(emissions, barrier).toEqual([
        { data: '', rawStartSeq: 0, rawEndSeq: '\x1b]10;?\x07'.length, transformed: true }
      ])
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

  it('keeps a POSIX query torn across the authority close and answers it', () => {
    const writes: string[] = []
    const emissions: PtyIngressEmission[] = []
    const ingress = new PtyStartupIngress({
      intent: { colors: COLORS, deadlineMs: 5_000 },
      ownerBackend: 'posix-pty',
      write: (data) => writes.push(data),
      onEmission: (emission) => emissions.push(emission)
    })

    ingress.accept('\x1b]10;')
    ingress.closeQueryAuthority()
    ingress.snapshotBarrier()
    expect(emissions).toEqual([])
    ingress.accept('?\x07')

    expect(writes).toEqual([FOREGROUND_REPLY])
    expect(visible(emissions)).toBe('')
  })

  it('answers a query long after startup on every backend and leaves other output alone', () => {
    // #22332: a Codex typed into a shell tab older than the old 5 s window.
    const input = 'typed\x1b[A\x1b]12;?\x1b\\\x1b]10;not-a-query\x07'
    vi.useFakeTimers()
    for (const ownerBackend of ['posix-pty', 'windows-wsl', 'windows-conpty'] as const) {
      const writes: string[] = []
      const emissions: PtyIngressEmission[] = []
      const ingress = new PtyStartupIngress({
        intent: { colors: COLORS, deadlineMs: 5_000 },
        ownerBackend,
        write: (data) => writes.push(data),
        onEmission: (emission) => emissions.push(emission)
      })
      ingress.closeQueryAuthority()
      vi.advanceTimersByTime(60_000)
      ingress.accept(`${input}\x1b]10;?\x07`)

      expect(writes, ownerBackend).toEqual([FOREGROUND_REPLY])
      expect(visible(emissions), ownerBackend).toBe(input)
    }
  })

  it('answers from host colours over spawn colours, reading them per query', () => {
    let hostColors: { foreground: string; background: string } | null = null
    const writes: string[] = []
    const ingress = new PtyStartupIngress({
      intent: { colors: COLORS, deadlineMs: 5_000 },
      resolveHostColors: () => hostColors,
      write: (data) => writes.push(data),
      onEmission: () => {}
    })

    ingress.accept('\x1b]11;?\x07')
    hostColors = { foreground: '#000000', background: '#123456' }
    ingress.accept('\x1b]11;?\x07')
    hostColors = { foreground: 'not-a-color', background: '#123456' }
    ingress.accept('\x1b]11;?\x07')

    expect(writes).toEqual([BACKGROUND_REPLY, '\x1b]11;rgb:1212/3434/5656\x1b\\', BACKGROUND_REPLY])
  })

  it('answers a PTY nobody reported colours for from the default theme', () => {
    // #22500: a headless host starts the agent before any viewer attaches.
    const writes: string[] = []
    const emissions: PtyIngressEmission[] = []
    const ingress = new PtyStartupIngress({
      write: (data) => writes.push(data),
      onEmission: (emission) => emissions.push(emission)
    })

    ingress.accept('before\x1b]10;?;?\x1b\\after')

    expect(writes).toEqual([DEFAULT_FOREGROUND_REPLY, DEFAULT_BACKGROUND_REPLY])
    expect(visible(emissions)).toBe('beforeafter')
  })

  it('swallows a cooked POSIX echo of its own reply without re-sending it', () => {
    // Kernel echo leaves the original reply in slave input; resending would become unsolicited stdin after raw mode starts.
    vi.useFakeTimers()
    for (const echoOf of POSIX_COOKED_ECHOES) {
      const writes: string[] = []
      const emissions: PtyIngressEmission[] = []
      let ingress!: PtyStartupIngress
      ingress = new PtyStartupIngress({
        intent: { colors: COLORS, deadlineMs: 5_000 },
        ownerBackend: 'posix-pty',
        write: (data) => {
          writes.push(data)
          ingress.accept(echoOf(data))
        },
        onEmission: (emission) => emissions.push(emission)
      })

      ingress.accept('\x1b]10;?\x07')
      vi.advanceTimersByTime(0)
      expect(writes).toEqual([FOREGROUND_REPLY])
      expect(visible(emissions)).toBe('')

      vi.advanceTimersByTime(5_000)
      expect(writes).toEqual([FOREGROUND_REPLY])
      expect(visible(emissions)).toBe('')
      ingress.drainAndClose()
    }
  })

  it('swallows a cooked POSIX echo coalesced behind earlier program output', () => {
    // Interactive launches coalesce reply echoes behind shell output; offset-zero recognition missed them (#12112).
    vi.useFakeTimers()
    for (const echoOf of POSIX_COOKED_ECHOES) {
      const replies: string[] = []
      const emissions: PtyIngressEmission[] = []
      const ingress = new PtyStartupIngress({
        intent: { colors: COLORS, deadlineMs: 5_000 },
        ownerBackend: 'posix-pty',
        write: (data) => replies.push(data),
        onEmission: (emission) => emissions.push(emission)
      })

      ingress.accept('\x1b]10;?\x07\x1b]11;?\x07')
      vi.advanceTimersByTime(0)
      expect(replies).toHaveLength(2)

      // A read with no echo in it must not retire the projections either.
      ingress.accept('booting...\r\n')
      ingress.accept(`\x1b[2JFRAME${replies.map((reply) => echoOf(reply)).join('')}`)
      ingress.drainAndClose()

      expect(visible(emissions)).toBe('booting...\r\n\x1b[2JFRAME')
    }
  })

  it('answers both slots when the deferred write lands between two reads of the burst', () => {
    // A torn second query must retain its BEL terminator; mistaking it for echo leaves OSC 11 unanswered and xterm unterminated.
    vi.useFakeTimers()
    const burst = '\x1b]10;?\x07\x1b]11;?\x07'
    for (let split = 0; split <= burst.length; split += 1) {
      const { ingress, writes, emissions } = createHarness()
      ingress.accept(burst.slice(0, split))
      vi.advanceTimersByTime(0)
      ingress.accept(burst.slice(split))
      vi.advanceTimersByTime(0)
      ingress.drainAndClose()

      expect(writes, `split ${split}`).toEqual([FOREGROUND_REPLY, BACKGROUND_REPLY])
      expect(visible(emissions), `split ${split}`).toBe('')
    }
  })

  it('keeps raw ranges disjoint when an echo lands on a retained torn query', () => {
    vi.useFakeTimers()
    const { ingress, writes, emissions } = createHarness()
    ingress.accept('\x1b]10;?\x07\x1b]11;?')
    vi.advanceTimersByTime(0)
    ingress.accept(`${writes[0]?.replaceAll('\x1b', '^[')}tail`)
    const accepted = ingress.drainAndClose()

    expect(visible(emissions)).toBe('\x1b]11;?tail')
    // Crossing suppressed ranges with a retained candidate corrupts sequence arithmetic and overlaps output ranges.
    expect(emissions.map((item) => [item.rawStartSeq, item.rawEndSeq])).toEqual([
      [0, 7],
      [7, 13],
      [13, 40],
      [40, accepted]
    ])
  })

  it('releases a partial echo hold long before the startup deadline', () => {
    vi.useFakeTimers()
    const { ingress, writes, emissions } = createHarness()
    ingress.accept('\x1b]10;?\x07')
    vi.advanceTimersByTime(0)
    expect(writes).toEqual([FOREGROUND_REPLY])

    // Bound relay-jitter tolerance without pinning an exact tunable hold duration.
    const RELAY_JITTER_MS = 400
    const WELL_BELOW_DEADLINE_MS = 1_500

    // A lone BEL is the head of the readline echo projection, so it is held.
    ingress.accept('\x07')
    expect(visible(emissions)).toBe('')
    vi.advanceTimersByTime(RELAY_JITTER_MS)
    expect(visible(emissions)).toBe('')
    vi.advanceTimersByTime(WELL_BELOW_DEADLINE_MS - RELAY_JITTER_MS)

    expect(visible(emissions)).toBe('\x07')
    ingress.drainAndClose()
  })

  it('still swallows the echo of a reply the startup deadline raced', () => {
    vi.useFakeTimers()
    const writes: string[] = []
    const emissions: PtyIngressEmission[] = []
    const ingress = new PtyStartupIngress({
      intent: { colors: COLORS, deadlineMs: 5_000 },
      ownerBackend: 'posix-pty',
      write: (data) => writes.push(data),
      onEmission: (emission) => emissions.push(emission)
    })

    vi.advanceTimersByTime(4_999)
    ingress.accept('\x1b]10;?\x07')
    // Cross the startup deadline while retaining the already-written reply.
    vi.advanceTimersByTime(2)
    expect(writes).toEqual([FOREGROUND_REPLY])

    ingress.accept(FOREGROUND_REPLY.replaceAll('\x1b', '^['))
    ingress.drainAndClose()
    expect(visible(emissions)).toBe('')
  })

  it('keeps the synchronous write for ConPTY-hosted wsl.exe panes', () => {
    // Why: a Windows-hosted pty must be answered before conhost's own responder.
    const writes: string[] = []
    const ingress = new PtyStartupIngress({
      intent: { colors: COLORS, deadlineMs: 5_000 },
      ownerBackend: 'windows-wsl',
      write: (data) => writes.push(data),
      onEmission: () => {}
    })

    ingress.accept('\x1b]10;?\x07')
    expect(writes).toEqual([FOREGROUND_REPLY])
    ingress.drainAndClose()
  })

  it('swallows a coalesced POSIX echo torn at every byte boundary', () => {
    // A prefix byte previously made split-echo detection leak at every boundary; real echoes follow shell output (#12112).
    vi.useFakeTimers()
    for (const echoOf of POSIX_COOKED_ECHOES) {
      const echo = echoOf(FOREGROUND_REPLY)
      for (let split = 1; split < echo.length; split += 1) {
        const writes: string[] = []
        const emissions: PtyIngressEmission[] = []
        const ingress = new PtyStartupIngress({
          intent: { colors: COLORS, deadlineMs: 5_000 },
          ownerBackend: 'posix-pty',
          write: (data) => writes.push(data),
          onEmission: (emission) => emissions.push(emission)
        })

        ingress.accept('\x1b]10;?\x07')
        vi.advanceTimersByTime(0)
        expect(writes).toEqual([FOREGROUND_REPLY])

        ingress.accept(`FRAME${echo.slice(0, split)}`)
        ingress.accept(echo.slice(split))
        ingress.drainAndClose()

        expect(visible(emissions)).toBe('FRAME')
      }
    }
  })

  it('still recognizes an echo that arrives behind an enormous splash frame', () => {
    // Large splash frames must not exhaust the echo-search budget before the echo arrives.
    vi.useFakeTimers()
    const writes: string[] = []
    const emissions: PtyIngressEmission[] = []
    const ingress = new PtyStartupIngress({
      intent: { colors: COLORS, deadlineMs: 5_000 },
      ownerBackend: 'posix-pty',
      write: (data) => writes.push(data),
      onEmission: (emission) => emissions.push(emission)
    })

    ingress.accept('\x1b]10;?\x07')
    vi.advanceTimersByTime(0)
    expect(writes).toEqual([FOREGROUND_REPLY])

    // One enormous splash frame must not retire the projection.
    ingress.accept('x'.repeat(64_000))
    ingress.accept(FOREGROUND_REPLY.replaceAll('\x1b', '^['))
    ingress.drainAndClose()

    expect(visible(emissions)).toBe('x'.repeat(64_000))
  })

  it('stops shadowing the stream once the projection outlives its search budget', () => {
    vi.useFakeTimers()
    const writes: string[] = []
    const emissions: PtyIngressEmission[] = []
    const ingress = new PtyStartupIngress({
      intent: { colors: COLORS, deadlineMs: 5_000 },
      ownerBackend: 'posix-pty',
      write: (data) => writes.push(data),
      onEmission: (emission) => emissions.push(emission)
    })

    ingress.accept('\x1b]10;?\x07')
    vi.advanceTimersByTime(0)
    const printed = 'tick\r\n'.repeat(50_000)
    ingress.accept(printed)

    // The echo never came, so a later exact collision is ordinary output again.
    const collision = FOREGROUND_REPLY.replaceAll('\x1b', '^[')
    ingress.accept(collision)
    ingress.drainAndClose()
    expect(visible(emissions)).toBe(`${printed}${collision}`)
  })

  it('answers a retry after a failed write', () => {
    vi.useFakeTimers()
    let failWrites = true
    const emissions: PtyIngressEmission[] = []
    const writes: string[] = []
    const ingress = new PtyStartupIngress({
      intent: { colors: COLORS, deadlineMs: 5_000 },
      ownerBackend: 'posix-pty',
      write: (data) => {
        if (failWrites) {
          throw new Error('EIO')
        }
        writes.push(data)
      },
      onEmission: (emission) => emissions.push(emission)
    })

    ingress.accept('\x1b]10;?\x07')
    vi.advanceTimersByTime(0)
    expect(writes).toEqual([])

    failWrites = false
    ingress.accept('\x1b]10;?\x07')
    vi.advanceTimersByTime(0)
    ingress.drainAndClose()
    expect(writes).toEqual([FOREGROUND_REPLY])
  })

  it('ages a projection out even when every read ends mid-candidate', () => {
    // Charge every read including mid-candidate early returns; otherwise missing echoes keep projections armed forever.
    vi.useFakeTimers()
    const writes: string[] = []
    const emissions: PtyIngressEmission[] = []
    const ingress = new PtyStartupIngress({
      intent: { colors: COLORS, deadlineMs: 5_000 },
      ownerBackend: 'posix-pty',
      write: (data) => writes.push(data),
      onEmission: (emission) => emissions.push(emission)
    })

    ingress.accept('\x1b]10;?\x07')
    vi.advanceTimersByTime(0)
    expect(writes).toEqual([FOREGROUND_REPLY])

    // Every read ends with a strict caret-prefix candidate.
    let printed = ''
    for (let read = 0; read < 8; read += 1) {
      const chunk = `${'line of output\r\n'.repeat(4_000)}^`
      printed += chunk
      ingress.accept(chunk)
    }

    const collision = FOREGROUND_REPLY.replaceAll('\x1b', '^[')
    ingress.accept(collision)
    ingress.drainAndClose()
    expect(visible(emissions)).toBe(`${printed}${collision}`)
  })

  it('swallows an echo no matter how finely the tty chunks it', () => {
    // SSH/slow drains can split echoes below any read budget; charge bytes rather than consuming the budget inside the echo.
    vi.useFakeTimers()
    const echo = FOREGROUND_REPLY.replaceAll('\x1b', '^[')
    for (const chunkSize of [1, 2, 3, 5, 13]) {
      const writes: string[] = []
      const emissions: PtyIngressEmission[] = []
      const ingress = new PtyStartupIngress({
        intent: { colors: COLORS, deadlineMs: 5_000 },
        ownerBackend: 'posix-pty',
        write: (data) => writes.push(data),
        onEmission: (emission) => emissions.push(emission)
      })

      ingress.accept('\x1b]10;?\x07')
      vi.advanceTimersByTime(0)
      expect(writes).toEqual([FOREGROUND_REPLY])
      for (let at = 0; at < echo.length; at += chunkSize) {
        ingress.accept(echo.slice(at, at + chunkSize))
      }
      ingress.drainAndClose()

      expect({ chunkSize, visible: visible(emissions) }).toEqual({ chunkSize, visible: '' })
    }
  })

  it('lets every downstream barrier cut a partial echo hold short', () => {
    // Downstream barriers bound waits independently; otherwise the generous continuation window becomes a real stall.
    vi.useFakeTimers()
    const cutShort: Record<string, (ingress: PtyStartupIngress) => void> = {
      snapshotBarrier: (ingress) => ingress.snapshotBarrier(),
      drainAndClose: (ingress) => ingress.drainAndClose(),
      startupDeadline: () => vi.advanceTimersByTime(5_000)
    }
    for (const [name, cut] of Object.entries(cutShort)) {
      const { ingress, writes, emissions } = createHarness()
      ingress.accept('\x1b]10;?\x07')
      vi.advanceTimersByTime(0)
      expect(writes).toEqual([FOREGROUND_REPLY])

      // A lone BEL heads the readline projection, so it is held rather than shown.
      ingress.accept('\x07')
      expect({ name, held: visible(emissions) }).toEqual({ name, held: '' })
      cut(ingress)

      expect({ name, released: visible(emissions) }).toEqual({ name, released: '\x07' })
    }
  })

  it('keeps swallowing an echo split across the query-authority handoff', () => {
    // Query-authority handoff does not cancel echoes already in flight; releasing the hold would expose half an echo.
    vi.useFakeTimers()
    const { ingress, writes, emissions } = createHarness()
    const echo = FOREGROUND_REPLY.replaceAll('\x1b', '^[')

    ingress.accept('\x1b]10;?\x07')
    vi.advanceTimersByTime(0)
    expect(writes).toEqual([FOREGROUND_REPLY])
    ingress.accept(echo.slice(0, 10))
    ingress.closeQueryAuthority()
    ingress.accept(echo.slice(10))
    ingress.drainAndClose()

    expect(visible(emissions)).toBe('')
  })

  it('swallows an echo whose halves straddle a relay-sized stall', () => {
    // Holds shorter than inter-chunk relay jitter release raw echo halves and reinstate leaks.
    vi.useFakeTimers()
    const echo = FOREGROUND_REPLY.replaceAll('\x1b', '^[')
    for (const gapMs of [50, 200, 400]) {
      const { ingress, writes, emissions } = createHarness()
      ingress.accept('\x1b]10;?\x07')
      vi.advanceTimersByTime(0)
      expect(writes).toEqual([FOREGROUND_REPLY])

      ingress.accept(echo.slice(0, 10))
      vi.advanceTimersByTime(gapMs)
      ingress.accept(echo.slice(10))
      ingress.drainAndClose()

      expect({ gapMs, visible: visible(emissions) }).toEqual({ gapMs, visible: '' })
    }
  })

  it('swallows an echo that arrives behind a query torn on an earlier read', () => {
    // A torn second query can precede the first reply’s echo; emit its completing prefix before consuming the echo.
    vi.useFakeTimers()
    const { ingress, writes, emissions } = createHarness()
    const echo = FOREGROUND_REPLY.replaceAll('\x1b', '^[')

    ingress.accept('\x1b]10;?\x07')
    vi.advanceTimersByTime(0)
    expect(writes).toEqual([FOREGROUND_REPLY])
    ingress.accept('\x1b]11;')
    ingress.accept(`?\x07${echo.slice(0, 8)}`)
    ingress.accept(echo.slice(8))
    vi.advanceTimersByTime(0)
    ingress.drainAndClose()

    expect(visible(emissions)).toBe('')
    // The torn query is still answered: it is the prefix that completes it.
    expect(writes).toEqual([FOREGROUND_REPLY, BACKGROUND_REPLY])
  })

  it('drops a torn query the next read disproves instead of the echo behind it', () => {
    // The echo disproves an offset-zero torn-query candidate; release that candidate before consuming the echo.
    vi.useFakeTimers()
    const { ingress, writes, emissions } = createHarness()
    const echo = FOREGROUND_REPLY.replaceAll('\x1b', '^[')

    ingress.accept('\x1b]10;?\x07')
    vi.advanceTimersByTime(0)
    ingress.accept('\x1b]11;')
    ingress.accept(echo.slice(0, 8))
    ingress.accept(echo.slice(8))
    vi.advanceTimersByTime(0)
    ingress.drainAndClose()

    // Only the program's own bytes survive; the echo is gone rather than trailing them.
    expect(visible(emissions)).toBe('\x1b]11;')
    expect(writes).toEqual([FOREGROUND_REPLY])
  })

  it('answers every query exactly once, including a repeat after a failed sibling write', () => {
    const writes: string[] = []
    const emissions: PtyIngressEmission[] = []
    const ingress = new PtyStartupIngress({
      intent: { colors: COLORS, deadlineMs: 5_000 },
      ownerBackend: 'windows-conpty',
      write: (data) => {
        if (data === BACKGROUND_REPLY) {
          throw new Error('EIO')
        }
        writes.push(data)
      },
      onEmission: (emission) => emissions.push(emission)
    })

    ingress.accept('\x1b]10;?\x07\x1b]11;?\x07')
    ingress.accept('\x1b]10;?\x07\x1b]11;?\x07')
    ingress.drainAndClose()
    expect(writes).toEqual([FOREGROUND_REPLY, FOREGROUND_REPLY])
    expect(visible(emissions)).toBe('')
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
