import { expect, it } from 'vitest'
import { TerminalOscColorOverrideTracker } from './terminal-osc-color-override-tracker'

const THEME = { foreground: '#ffffff', background: '#282c34' }

it('reports an app-set colour until the app resets it', () => {
  const tracker = new TerminalOscColorOverrideTracker()
  tracker.scan('before\x1b]11;rgb:1010/2020/3030\x07after', () => THEME)
  expect(tracker.resolve(THEME)).toEqual({ foreground: '#ffffff', background: '#102030' })

  tracker.scan('\x1b]10;#abcdef\x1b\\', () => THEME)
  expect(tracker.resolve(THEME)).toEqual({ foreground: '#abcdef', background: '#102030' })

  tracker.scan('\x1b]111\x07', () => THEME)
  expect(tracker.resolve(THEME)).toEqual({ foreground: '#abcdef', background: '#282c34' })
  tracker.scan('\x1b]110\x1b\\', () => THEME)
  expect(tracker.resolve(THEME)).toEqual(THEME)
})

it('stacks OSC 10 params onto the background and survives a split at every byte', () => {
  const sequence = '\x1b]10;#111111;#222222\x1b\\'
  for (let split = 0; split <= sequence.length; split += 1) {
    const tracker = new TerminalOscColorOverrideTracker()
    tracker.scan(`x${sequence.slice(0, split)}`, () => THEME)
    tracker.scan(`${sequence.slice(split)}y`, () => THEME)
    expect(tracker.resolve(THEME), `split ${split}`).toEqual({
      foreground: '#111111',
      background: '#222222'
    })
  }
})

it('ignores queries, malformed specs, other OSCs and aborted sequences', () => {
  const tracker = new TerminalOscColorOverrideTracker()
  tracker.scan('\x1b]11;?\x07\x1b]11;blue\x07\x1b]1;title\x07\x1b]12;#000000\x07', () => THEME)
  tracker.scan('\x1b]11;#000000\x1b[0m\x07', () => THEME)
  expect(tracker.resolve(THEME)).toEqual(THEME)
})

it('drops app-set colours when the theme they were set over changes', () => {
  const tracker = new TerminalOscColorOverrideTracker()
  tracker.scan('\x1b]11;#000000\x07', () => THEME)
  const light = { foreground: '#2e3434', background: '#ffffff' }
  expect(tracker.resolve(light)).toEqual(light)
  expect(tracker.resolve(THEME)).toEqual(THEME)
})

it('finds a colour set behind a run of ST-terminated hyperlinks', () => {
  const tracker = new TerminalOscColorOverrideTracker()
  const links = '\x1b]8;;file:///a\x1b\\a\x1b]8;;\x1b\\ '.repeat(200)
  tracker.scan(`${links}\x1b]11;#010203\x07${links}`, () => THEME)
  expect(tracker.resolve(THEME)).toEqual({ foreground: '#ffffff', background: '#010203' })
})
