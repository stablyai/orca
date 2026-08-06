import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  PtyStartupIngress,
  parsePtyStartupIngressIntent,
  type PtyIngressEmission
} from './pty-startup-ingress'
import type {
  PtySlaveEchoProbe,
  PtySlaveLineDisciplineEcho
} from './pty-slave-line-discipline-echo'

const COLORS = { foreground: '#2e3434', background: '#ffffff' }
const FOREGROUND_REPLY = '\x1b]10;rgb:2e2e/3434/3434\x1b\\'
const BACKGROUND_REPLY = '\x1b]11;rgb:ffff/ffff/ffff\x1b\\'
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
    echoProbe?: PtySlaveEchoProbe
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
    ...(options.echoProbe ? { echoProbe: options.echoProbe } : {}),
    write: (data) => {
      writes.push(data)
      options.nested?.(data)
    },
    onEmission: (emission) => emissions.push(emission)
  })
  return { ingress, writes, emissions }
}

/** Probe that answers from a script, repeating its last answer once exhausted. */
function scriptedEchoProbe(...states: PtySlaveLineDisciplineEcho[]) {
  let index = 0
  const probe: PtySlaveEchoProbe & { calls: number } = Object.assign(
    async () => {
      probe.calls += 1
      return states[Math.min(index++, states.length - 1)] ?? 'unknown'
    },
    { calls: 0 }
  )
  return probe
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

  it('recognizes BEL/ST queries at every split and defers canonical replies', () => {
    vi.useFakeTimers()
    const query = '\x1b]10;?\x07\x1b]11;?\x1b\\'
    for (let split = 0; split <= query.length; split += 1) {
      const { ingress, writes, emissions } = createHarness()
      ingress.accept(query.slice(0, split))
      ingress.accept(query.slice(split))
      // Why: answering inside the query's own turn beats the querying program's
      // tcsetattr, so a cooked tty echoes the reply as text instead (#12112).
      expect(writes, `split ${split}`).toEqual([])
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

  it('consumes a native ConPTY color query before any downstream responder at every split', () => {
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
    expect(visible(emissions)).toBe(input)
  })

  it('swallows a cooked POSIX echo of its own reply without re-sending it', () => {
    // Why never re-send: POSIX ECHO copies the reply to the master but leaves it in
    // the slave input queue, so the program still reads it; a second write would
    // arrive on its stdin as unsolicited input once it is raw.
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
    // Why this shape: an agent pane is launched by writing a command into an interactive
    // shell, so the tty echo of Orca's reply never arrives at the head of a read (#12112).
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
    // Why between: a pty read boundary is a macrotask, so the deferred reply is written
    // while the rest of the burst is still unread. A `\x07` head-of-echo guess taken then
    // steals the OSC 11 terminator, leaving the slot unanswered and its bytes emitted
    // after the BEL — which parks xterm in an OSC that never terminates.
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
    // Why exact ranges: a candidate carried across the suppressed echo re-emits its own
    // bytes on a span whose end no longer matches its data, so ranges start to overlap.
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

    // Why a range and not the exact hold: what matters is that the guess outlasts
    // relay jitter yet still resolves without the deadline's help. Pinning the exact
    // value would fail on any honest retune while teaching the retuner nothing.
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
    // The deferred write flushes at 4_999, then the deadline expires at 5_000.
    vi.advanceTimersByTime(2)
    expect(writes).toEqual([FOREGROUND_REPLY])

    ingress.accept(FOREGROUND_REPLY.replaceAll('\x1b', '^['))
    ingress.drainAndClose()
    expect(visible(emissions)).toBe('')
  })

  it('writes a reply the startup deadline raced instead of dropping it', () => {
    // Why: the query span was already consumed, so nobody downstream can answer it.
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
    expect(writes).toEqual([])
    vi.advanceTimersByTime(1)

    expect(visible(emissions)).toBe('')
    expect(writes).toEqual([FOREGROUND_REPLY])
    ingress.drainAndClose()
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
    // Why a prefix matters: recognition used to hold a split echo only when it began
    // at offset 0, so a single byte of program output ahead of it made every torn
    // boundary leak the reply verbatim — the exact #12112 symptom the fix targets.
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
    // Why: the search budget must not be spent by one large frame, retiring the
    // projection while the echo is still in flight behind it.
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

  it('bounds echo suppression to a few hundred bytes past the startup deadline', () => {
    // Why: reset() keeps a raced reply recognizable, but an unbounded projection would
    // keep deleting matching spans out of ordinary output for the rest of the session.
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
    vi.advanceTimersByTime(2)
    expect(writes).toEqual([FOREGROUND_REPLY])

    const printed = 'a\r\n'.repeat(200)
    ingress.accept(printed)
    const collision = FOREGROUND_REPLY.replaceAll('\x1b', '^[')
    ingress.accept(collision)
    ingress.drainAndClose()

    expect(visible(emissions)).toBe(`${printed}${collision}`)
  })

  it('drops its answered claim when a deferred write fails so a retry falls through', () => {
    // Why: the deferred write already reported success, so the first query was consumed
    // on its behalf. Without the rollback the slot stays claimed forever and no
    // downstream color authority ever sees the query either.
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
    // Why: the read budget is charged once per read at the entry point, so a stream
    // whose every read ends on a candidate byte still retires a projection that never
    // lands. Charging only on reads that fall through left it alive forever.
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

    // A trailing `^` is a strict prefix of the caret projection, so every one of these
    // reads returns holding a candidate.
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
    // Why: an SSH relay or a slow drain delivers the echo a few bytes at a time. A
    // per-read budget was spent inside the echo itself, so the leak came back for any
    // chunking finer than the budget.
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
    // Why pinned: the hold window is only affordable because it is not what bounds
    // the wait — these are. If one stopped releasing, the window would become a
    // real stall rather than a bet on the next read.
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
    // Why the asymmetry with snapshotBarrier is deliberate: closing query authority
    // hands off who may answer, but the reply is already on the wire and its echo is
    // still Orca's to swallow. Cutting the hold here would show its first half.
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
    // Why: an expired hold releases raw, so a hold shorter than real inter-chunk
    // jitter reinstates the leak on exactly the links Orca has to work over.
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
    // Why: the tty can tear the program's second query and start echoing the first
    // reply in the same read. Refusing to hold while a query is pending leaked the
    // whole echo, because the prefix that would have completed that query was never
    // emitted first.
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
    // Why: with the echo starting at offset 0 there is no prefix to complete the torn
    // candidate, so preferring it fed the echo to the raw path and printed both. The
    // candidate is not a color query at all once the echo's first byte lands.
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

  it('keeps a landed reply claimed when the sibling query write fails', () => {
    // Why: ConPTY writes inside the query's own turn, so one span can land slot 10 and
    // lose slot 11. Forgetting every claim would answer 10 a second time, and a
    // duplicate reply corrupts a parser already mid-read.
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
    expect(writes).toEqual([FOREGROUND_REPLY])
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

  it('withholds the reply while the slave would echo it, then writes once it is quiet', async () => {
    vi.useFakeTimers()
    const echoProbe = scriptedEchoProbe('echoing', 'echoing', 'quiet')
    const { ingress, writes } = createHarness({ echoProbe })
    ingress.accept('\x1b]10;?\x07')
    await vi.advanceTimersByTimeAsync(0)
    // Nothing may go out while the line discipline is still cooked: that write is the
    // one that comes straight back as visible junk (#12112).
    expect(writes).toEqual([])
    await vi.advanceTimersByTimeAsync(20)
    expect(writes).toEqual([])
    await vi.advanceTimersByTimeAsync(20)
    expect(writes).toEqual([FOREGROUND_REPLY])
    expect(echoProbe.calls).toBe(3)
    ingress.drainAndClose()
  })

  it('retires only the kernel caret projection once the probe proves ECHO is clear', async () => {
    vi.useFakeTimers()
    const { ingress, writes, emissions } = createHarness({
      echoProbe: scriptedEchoProbe('quiet')
    })
    ingress.accept('\x1b]10;?\x07')
    await vi.advanceTimersByTimeAsync(0)
    expect(writes).toEqual([FOREGROUND_REPLY])
    // A cleared ECHO bit proves the kernel cannot produce the caret form, so output
    // that merely resembles it is ordinary program output and must survive.
    const caret = POSIX_COOKED_ECHOES[0]?.(FOREGROUND_REPLY) ?? ''
    ingress.accept(caret)
    ingress.drainAndClose()
    expect(visible(emissions)).toBe(caret)
  })

  it('still suppresses the readline echo on a slave the probe called quiet', async () => {
    vi.useFakeTimers()
    const { ingress, writes, emissions } = createHarness({
      echoProbe: scriptedEchoProbe('quiet')
    })
    ingress.accept('\x1b]10;?\x07')
    await vi.advanceTimersByTimeAsync(0)
    expect(writes).toEqual([FOREGROUND_REPLY])
    // Why: readline echoes a master write in software with the tty already raw and
    // ECHO off, so `quiet` is no evidence at all about this shape. Verified on a live
    // pty: at a bash prompt the probe reports quiet and readline still emits it.
    ingress.accept(POSIX_COOKED_ECHOES[1]?.(FOREGROUND_REPLY) ?? '')
    ingress.drainAndClose()
    expect(visible(emissions)).toBe('')
  })

  it('falls back to recognizing echo shapes when the probe cannot answer', async () => {
    vi.useFakeTimers()
    const { ingress, writes, emissions } = createHarness({
      echoProbe: scriptedEchoProbe('unknown')
    })
    ingress.accept('\x1b]10;?\x07')
    await vi.advanceTimersByTimeAsync(0)
    expect(writes).toEqual([FOREGROUND_REPLY])
    // `unknown` is not evidence of quiet, so the guess stays armed and swallows the echo.
    ingress.accept(POSIX_COOKED_ECHOES[0]?.(FOREGROUND_REPLY) ?? '')
    ingress.drainAndClose()
    expect(visible(emissions)).toBe('')
  })

  it('falls back immediately when the echo probe rejects', async () => {
    vi.useFakeTimers()
    const echoProbe: PtySlaveEchoProbe = async () => {
      throw new Error('probe failed')
    }
    const { ingress, writes, emissions } = createHarness({ echoProbe })
    ingress.accept('\x1b]10;?\x07')

    await vi.advanceTimersByTimeAsync(0)

    expect(writes).toEqual([FOREGROUND_REPLY])
    ingress.accept(POSIX_COOKED_ECHOES[0]?.(FOREGROUND_REPLY) ?? '')
    ingress.drainAndClose()
    expect(visible(emissions)).toBe('')
  })

  it('stops polling a tty that never leaves cooked mode and answers it anyway', async () => {
    vi.useFakeTimers()
    const echoProbe = scriptedEchoProbe('echoing')
    const { ingress, writes, emissions } = createHarness({ echoProbe })
    ingress.accept('\x1b]10;?\x07')
    await vi.advanceTimersByTimeAsync(1_000)
    // Waiting past this point only delays a reply that will echo whenever it is sent,
    // so the reply goes out with the shape guess armed rather than being dropped.
    expect(writes).toEqual([FOREGROUND_REPLY])
    // Bounded in wall-clock, not in probes: under fork contention each probe takes
    // longer and the budget buys fewer of them, instead of the wait growing.
    expect(echoProbe.calls).toBeLessThanOrEqual(11)
    ingress.accept(POSIX_COOKED_ECHOES[0]?.(FOREGROUND_REPLY) ?? '')
    ingress.drainAndClose()
    expect(visible(emissions)).toBe('')
  })

  it('gives a later query its own probe budget, not the first query remainder', async () => {
    vi.useFakeTimers()
    const echoProbe = scriptedEchoProbe('echoing')
    const { ingress, writes } = createHarness({ echoProbe })
    ingress.accept('\x1b]10;?\x07')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(writes).toEqual([FOREGROUND_REPLY])
    const spentOnFirst = echoProbe.calls
    // Why: OSC 10 and OSC 11 routinely arrive more than a budget apart over SSH. A
    // counter carried across them would send the second reply out entirely unprobed.
    ingress.accept('\x1b]11;?\x07')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(writes).toEqual([FOREGROUND_REPLY, BACKGROUND_REPLY])
    expect(echoProbe.calls).toBeGreaterThan(spentOnFirst)
    ingress.drainAndClose()
  })

  it('answers a still-pending reply when the startup deadline expires mid-poll', async () => {
    vi.useFakeTimers()
    const { ingress, writes } = createHarness({ echoProbe: scriptedEchoProbe('echoing') })
    ingress.accept('\x1b]10;?\x07')
    await vi.advanceTimersByTimeAsync(60)
    expect(writes).toEqual([])
    // The deadline is the outer bound: a reply held by a cooked tty still gets sent
    // rather than dropped, because the querying program is blocked on it.
    await vi.advanceTimersByTimeAsync(5_000)
    expect(writes).toEqual([FOREGROUND_REPLY])
    ingress.drainAndClose()
  })

  it('drops a held reply on teardown instead of writing to a dead pty', async () => {
    vi.useFakeTimers()
    const { ingress, writes } = createHarness({ echoProbe: scriptedEchoProbe('echoing') })
    ingress.accept('\x1b]10;?\x07')
    await vi.advanceTimersByTimeAsync(20)
    ingress.drainAndClose()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(writes).toEqual([])
  })
})
