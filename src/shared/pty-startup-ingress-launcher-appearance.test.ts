import { describe, expect, it } from 'vitest'
import { PtyStartupIngress, type PtyIngressEmission } from './pty-startup-ingress'
import { parsePtyStartupIngressIntent } from './pty-startup-ingress-intent'
import type { TerminalViewAttributes, TerminalViewRgb } from './terminal-view-attributes'

// The host window is dark; the remote client that launched the PTY is light (#34340).
const HOST = { foreground: '#ffffff', background: '#000000' }
const LAUNCHER: TerminalViewAttributes = {
  foreground: [0x2e, 0x34, 0x34],
  background: [0xff, 0xff, 0xff],
  cursor: [0x11, 0x22, 0x33],
  ansi: Array.from({ length: 256 }, (_, i): TerminalViewRgb => [i, i, i]),
  colorSchemeMode: 'light',
  cursorStyle: 'block',
  cursorBlink: false
}
const LAUNCHER_COLORS = { foreground: '#2e3434', background: '#ffffff' }

const LIGHT_SCHEME = '\x1b[?997;2n'
const DARK_SCHEME = '\x1b[?997;1n'
const PALETTE_1 = '\x1b]4;1;rgb:0101/0101/0101\x1b\\'
const CURSOR = '\x1b]12;rgb:1111/2222/3333\x1b\\'
const LAUNCHER_BACKGROUND = '\x1b]11;rgb:ffff/ffff/ffff\x1b\\'

function harness(launcher: 'full' | 'colors-only' | 'none') {
  // Through the owner's wire parse, as a daemon receives it.
  const intent = parsePtyStartupIngressIntent(
    JSON.parse(
      JSON.stringify({
        colors: HOST,
        deadlineMs: 5000,
        ...(launcher !== 'none' ? { launcherColors: LAUNCHER_COLORS } : {}),
        ...(launcher === 'full' ? { launcherAttributes: LAUNCHER } : {})
      })
    )
  )
  const writes: string[] = []
  const emissions: PtyIngressEmission[] = []
  const ingress = new PtyStartupIngress({
    ...(intent ? { intent } : {}),
    ownerBackend: 'posix-pty',
    resolveHostColors: () => HOST,
    write: (data) => writes.push(data),
    onEmission: (emission) => emissions.push(emission)
  })
  const visible = (): string => emissions.map((emission) => emission.data).join('')
  return { ingress, writes, emissions, visible }
}

describe("a launcher-pinned PTY's owner answers every theme query (#34340)", () => {
  it("answers ?996n, OSC 4/11/12 with the launcher's theme and hides them from the viewers", () => {
    const { ingress, writes, visible } = harness('full')

    ingress.accept('a\x1b[?996nb\x1b]4;1;?\x07c\x1b]12;?\x1b\\d\x1b]11;?\x07e')
    ingress.drainAndClose()

    expect(writes).toEqual([LIGHT_SCHEME, PALETTE_1, CURSOR, LAUNCHER_BACKGROUND])
    expect(visible()).toBe('abcde')
  })

  it('answers stacked OSC 10/11 queries slot by slot with the same theme', () => {
    const { ingress, writes, visible } = harness('full')

    ingress.accept('\x1b]10;?;?;?\x07\x1b]11;?;?\x07')

    const foreground = '\x1b]10;rgb:2e2e/3434/3434\x1b\\'
    expect(writes).toEqual([foreground, LAUNCHER_BACKGROUND, CURSOR, LAUNCHER_BACKGROUND, CURSOR])
    expect(visible()).toBe('')
  })

  it('answers the same at every split across two reads, keeping sequence coverage', () => {
    const bytes = 'out\x1b[?996n\x1b]4;1;?;2;?\x1b\\more'
    for (let split = 0; split <= bytes.length; split++) {
      const { ingress, writes, emissions, visible } = harness('full')
      ingress.accept(bytes.slice(0, split))
      ingress.accept(bytes.slice(split))
      ingress.drainAndClose()

      expect(writes).toEqual([LIGHT_SCHEME, PALETTE_1, '\x1b]4;2;rgb:0202/0202/0202\x1b\\'])
      expect(visible()).toBe('outmore')
      let end = 0
      for (const span of emissions) {
        expect(span.rawStartSeq).toBe(end)
        end = span.rawEndSeq
      }
      expect(end).toBe(bytes.length)
    }
  })

  it('leaves ordinary output, colour sets and other sequences to the viewers', () => {
    const { ingress, writes, visible } = harness('full')
    const ordinary = '\x1b[31mred\x1b[0m \x1b]0;title\x07\x1b[?25l\x1b[6n\x1b]4;1;#123456\x07'

    ingress.accept(`${ordinary}\x1b]4;1;?\x07\x1b]104\x07\x1b]4;1;?\x07`)
    ingress.drainAndClose()

    // The app's OSC 4 set reaches the viewers and is reported until OSC 104 resets it.
    expect(writes).toEqual(['\x1b]4;1;rgb:1212/3434/5656\x1b\\', PALETTE_1])
    expect(visible()).toBe(`${ordinary}\x1b]104\x07`)
  })

  it('reports a long palette SET torn across reads, and a cursor stacked onto OSC 11', () => {
    const { ingress, writes } = harness('full')
    const set = `\x1b]4;${Array.from({ length: 40 }, (_, i) => `${i};#0000ff`).join(';')}\x07`

    ingress.accept(set.slice(0, 300))
    ingress.accept(`${set.slice(300)}\x1b]4;39;?\x07\x1b]11;#000000;#abcdef\x07\x1b]12;?\x07`)

    expect(writes).toEqual([
      '\x1b]4;39;rgb:0000/0000/ffff\x1b\\',
      '\x1b]12;rgb:abab/cdcd/efef\x1b\\'
    ])
  })

  it('answers the queries of a mixed SET/query OSC and passes its SETs on, left to right', () => {
    const { ingress, writes, visible } = harness('full')

    ingress.accept('\x1b]4;1;?;2;#ff0000\x07\x1b]4;3;#00ff00;3;?\x07\x1b]10;#ffffff;?\x07')

    expect(writes).toEqual([PALETTE_1, '\x1b]4;3;rgb:0000/ffff/0000\x1b\\', LAUNCHER_BACKGROUND])
    expect(visible()).toBe('\x1b]4;2;#ff0000\x1b\\\x1b]4;3;#00ff00\x1b\\\x1b]10;#ffffff\x1b\\')
  })

  it('reads over-stacked queries and padded indexes as the headless responder does', () => {
    const { ingress, writes, visible } = harness('full')

    ingress.accept('\x1b]11;?;?;?\x07\x1b]4;0001;?;999;?\x07')

    expect(writes).toEqual([LAUNCHER_BACKGROUND, CURSOR, PALETTE_1])
    expect(visible()).toBe('')
  })

  it('holds only a torn CSI that can still become ?996n across barriers, and answers it', () => {
    const { ingress, writes, visible } = harness('full')

    ingress.accept('foo\x1b[')
    ingress.snapshotBarrier()
    ingress.accept('?996nbar\x1b[?2')
    ingress.snapshotBarrier()

    expect(writes).toEqual([LIGHT_SCHEME])
    expect(visible()).toBe('foobar\x1b[?2')
  })

  it('reports ?996n from colours the app set on top of the launcher theme', () => {
    const { ingress, writes } = harness('full')

    ingress.accept('\x1b]11;#000000\x07\x1b[?996n')

    expect(writes).toEqual([DARK_SCHEME])
  })

  it('stays silent for OSC 4/12 when an older client sent no palette, still owning them', () => {
    const { ingress, writes, visible } = harness('colors-only')

    ingress.accept('\x1b]4;1;?\x07\x1b]12;?\x07\x1b[?996n')

    expect(writes).toEqual([LIGHT_SCHEME])
    expect(visible()).toBe('')
  })

  it('passes OSC 4/12 and ?996n through untouched without a launcher, as before', () => {
    const { ingress, writes, visible } = harness('none')
    const queries = 'a\x1b[?996nb\x1b]4;1;?\x07c\x1b]12;?\x1b\\d'

    ingress.accept(queries)
    ingress.drainAndClose()

    expect(writes).toEqual([])
    expect(visible()).toBe(queries)
  })
})

it('keeps the launcher palette across the wire only beside launcher colours', () => {
  const wire = (value: unknown) => parsePtyStartupIngressIntent(JSON.parse(JSON.stringify(value)))

  expect(
    wire({
      colors: HOST,
      deadlineMs: 0,
      launcherColors: LAUNCHER_COLORS,
      launcherAttributes: LAUNCHER
    })?.launcherAttributes
  ).toEqual(LAUNCHER)
  expect(wire({ colors: HOST, deadlineMs: 0, launcherAttributes: LAUNCHER })).not.toHaveProperty(
    'launcherAttributes'
  )
})

it("forwards a mixed OSC's SETs to the viewers when ConPTY's reply write fails", () => {
  const intent = parsePtyStartupIngressIntent({
    colors: HOST,
    deadlineMs: 5000,
    launcherColors: LAUNCHER_COLORS,
    launcherAttributes: LAUNCHER
  })
  const emissions: PtyIngressEmission[] = []
  const ingress = new PtyStartupIngress({
    ...(intent ? { intent } : {}),
    ownerBackend: 'windows-conpty',
    resolveHostColors: () => HOST,
    write: () => {
      throw new Error('EIO')
    },
    onEmission: (emission) => emissions.push(emission)
  })

  ingress.accept('a\x1b]4;1;#ff0000;2;?\x07b')

  // ConPTY still withholds the query itself (#9651), but the viewers must paint the SET.
  expect(emissions.map((emission) => emission.data).join('')).toBe('a\x1b]4;1;#ff0000\x1b\\b')
})
