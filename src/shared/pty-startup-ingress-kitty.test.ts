import { afterEach, expect, it, vi } from 'vitest'
import {
  PtyStartupIngress,
  parsePtyStartupIngressIntent,
  type PtyIngressEmission
} from './pty-startup-ingress'

const colors = { foreground: '#ffffff', background: '#000000' }
afterEach(() => vi.useRealTimers())

function fixture(enabled = true, conpty = false) {
  const writes: string[] = []
  const emissions: PtyIngressEmission[] = []
  const ingress = new PtyStartupIngress({
    intent: { colors, deadlineMs: 5000, ...(enabled ? { kittyKeyboardProtocol: true } : {}) },
    ownerBackend: conpty ? 'windows-conpty' : 'posix-pty',
    write: (data) => writes.push(data),
    onEmission: (data) => emissions.push(data)
  })
  return { ingress, writes, emissions, visible: () => emissions.map((item) => item.data).join('') }
}

it.each([false, true])(
  'answers the OMP probe at every byte split, retaining modes and sequence coverage (ConPTY %s)',
  (conpty) => {
    const bytes = 'prompt\x1b[?u\x1b[c\x1b[>5uREADY'
    for (let split = 0; split <= bytes.length; split++) {
      const f = fixture(true, conpty)
      f.ingress.accept(bytes.slice(0, split))
      f.ingress.accept(bytes.slice(split))
      f.ingress.drainAndClose()
      expect(f.writes).toEqual(['\x1b[?0u'])
      expect(f.visible()).toBe('prompt\x1b[c\x1b[>5uREADY')
      let end = 0
      for (const span of f.emissions) {
        expect(span.rawStartSeq).toBe(end)
        end = span.rawEndSeq
      }
      expect(end).toBe(bytes.length)
    }
  }
)
it('uses preceding mode state, answers only once, and does not eat CSI-u key sequences', () => {
  const f = fixture()
  f.ingress.accept('\x1b[>3u\x1b[?u\x1b[?u\x1b[97;6u')
  expect(f.writes).toEqual(['\x1b[?3u'])
  expect(f.visible()).toBe('\x1b[>3u\x1b[?u\x1b[97;6u')
  f.ingress.drainAndClose()
})
it.each([false, true])(
  'hands a split query to the renderer after authority closes (ConPTY %s)',
  (conpty) => {
    const f = fixture(true, conpty)
    f.ingress.accept('\x1b[?')
    f.ingress.closeQueryAuthority()
    f.ingress.accept('u\x1b[>5u')
    expect(f.writes).toEqual([])
    expect(f.visible()).toBe('\x1b[?u\x1b[>5u')
    f.ingress.drainAndClose()
  }
)
it('requires explicit capability and stops answering at the deadline', () => {
  vi.useFakeTimers()
  for (const enabled of [false, true]) {
    const f = fixture(enabled)
    vi.advanceTimersByTime(5001)
    f.ingress.accept('\x1b[?u')
    expect(f.writes).toEqual([])
    expect(f.visible()).toBe('\x1b[?u')
    f.ingress.drainAndClose()
  }
  expect(
    parsePtyStartupIngressIntent({ colors, deadlineMs: 5000, kittyKeyboardProtocol: 'true' })
  ).not.toHaveProperty('kittyKeyboardProtocol')
})
it('leaves an unacknowledged query available when the owner write fails', () => {
  const emissions: PtyIngressEmission[] = []
  const ingress = new PtyStartupIngress({
    intent: { colors, deadlineMs: 5000, kittyKeyboardProtocol: true },
    write: () => {
      throw new Error('closed')
    },
    onEmission: (span) => emissions.push(span)
  })
  ingress.accept('\x1b[?u')
  expect(emissions.map((span) => span.data).join('')).toBe('\x1b[?u')
  ingress.drainAndClose()
})
it('retains Kitty authority after both color slots have been answered', () => {
  const f = fixture()
  f.ingress.accept('\x1b]10;?\x07\x1b]11;?\x07')
  f.ingress.accept('\x1b[?u')
  expect(f.writes.at(-1)).toBe('\x1b[?0u')
  expect(f.writes).toHaveLength(3)
  expect(f.visible()).toBe('')
  f.ingress.drainAndClose()
})
it.each([false, true])(
  'does not advertise a capability absent from the renderer (ConPTY %s)',
  (conpty) => {
    const f = fixture(false, conpty)
    f.ingress.accept('\x1b[?u\x1b[>5u')
    expect(f.writes).toEqual([])
    expect(f.visible()).toBe('\x1b[?u\x1b[>5u')
    f.ingress.drainAndClose()
  }
)

it.each([false, true])('tracks fragmented pre-query mode changes on ConPTY %s', (conpty) => {
  const bytes = '\x1b[>5u\x1b[>3u\x1b[<u\x1b[?uTAIL'
  for (let split = 0; split <= bytes.length; split++) {
    const f = fixture(true, conpty)
    f.ingress.accept(bytes.slice(0, split))
    f.ingress.accept(bytes.slice(split))
    f.ingress.drainAndClose()
    expect(f.writes).toEqual(['\x1b[?5u'])
    expect(f.visible()).toBe(bytes.replace('\x1b[?u', ''))
    expect(f.emissions[0]?.rawStartSeq).toBe(0)
    expect(f.emissions.at(-1)?.rawEndSeq).toBe(bytes.length)
  }
})

it('keeps ConPTY color authority after Kitty hands off', () => {
  const f = fixture(true, true)
  f.ingress.closeQueryAuthority()
  f.ingress.accept('\x1b[?u\x1b]10;?\x07')
  expect(f.writes).toEqual(['\x1b]10;rgb:ffff/ffff/ffff\x1b\\'])
  expect(f.visible()).toBe('\x1b[?u')
  f.ingress.drainAndClose()
})

it.each([undefined, {}, { foreground: '#fff' }, { background: 'invalid' }])(
  'answers a Kitty-only intent independently of colors %j',
  (colors) => {
    const intent = parsePtyStartupIngressIntent({
      colors,
      kittyKeyboardProtocol: true,
      deadlineMs: 5000
    })
    expect(intent).toBeDefined()
    const writes: string[] = []
    const emissions: PtyIngressEmission[] = []
    const ingress = new PtyStartupIngress({
      intent,
      write: (data) => writes.push(data),
      onEmission: (span) => emissions.push(span)
    })
    ingress.accept('\x1b[?u\x1b[c')
    ingress.drainAndClose()
    expect(writes).toEqual(['\x1b[?0u'])
    expect(emissions.map((span) => span.data).join('')).toBe('\x1b[c')
  }
)
it.each([undefined, false, 'true', 1])(
  'rejects colorless intents without explicit Kitty support: %j',
  (kittyKeyboardProtocol) => {
    expect(
      parsePtyStartupIngressIntent({ kittyKeyboardProtocol, deadlineMs: 5000 })
    ).toBeUndefined()
  }
)
it.each([-1, 30001, Number.NaN, Infinity, '5000', undefined])(
  'rejects an invalid Kitty-only deadline: %j',
  (deadlineMs) => {
    expect(
      parsePtyStartupIngressIntent({ kittyKeyboardProtocol: true, deadlineMs })
    ).toBeUndefined()
  }
)
