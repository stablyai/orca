import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Terminal } from '@xterm/xterm'

import { TerminalContextualShapingAddon } from './terminal-contextual-shaping-addon'

function createTerminalHarness(fontFamily: string) {
  let registeredJoiner: ((text: string) => [number, number][]) | null = null
  const deregisterCharacterJoiner = vi.fn()
  const refresh = vi.fn()
  const terminal = {
    rows: 24,
    options: { fontFamily },
    refresh,
    registerCharacterJoiner(joiner: (text: string) => [number, number][]): number {
      registeredJoiner = joiner
      return 5
    },
    deregisterCharacterJoiner
  } as unknown as Terminal
  return {
    terminal,
    refresh,
    deregisterCharacterJoiner,
    getRegisteredJoiner: () => registeredJoiner!,
    setFontFamily: (fontFamily: string) => {
      ;(terminal.options as { fontFamily: string }).fontFamily = fontFamily
    }
  }
}

describe('TerminalContextualShapingAddon', () => {
  let harness: ReturnType<typeof createTerminalHarness>

  beforeEach(() => {
    harness = createTerminalHarness('"Fast_Mono", "Menlo", monospace')
  })

  it('joins whole letter runs so the shaper sees complete words', () => {
    new TerminalContextualShapingAddon().activate(harness.terminal)
    const joiner = harness.getRegisteredJoiner()

    expect(joiner('NiTE@MacBook-Air TaxiRadar % supersonic')).toEqual([
      [0, 4],
      [5, 12],
      [13, 16],
      [17, 26],
      [29, 39]
    ])
  })

  it('skips single letters — an isolated cell shapes no differently joined', () => {
    new TerminalContextualShapingAddon().activate(harness.terminal)
    expect(harness.getRegisteredJoiner()('a b - c')).toEqual([])
  })

  it('keeps combining marks inside the word run', () => {
    new TerminalContextualShapingAddon().activate(harness.terminal)
    // 'nai' + U+0308 COMBINING DIAERESIS + 've text' — escapes pin the code units.
    expect(harness.getRegisteredJoiner()('nai\u0308ve text')).toEqual([
      [0, 6],
      [7, 11]
    ])
  })

  it('returns no ranges for fonts without word-dependent shaping', () => {
    const other = createTerminalHarness('"SF Mono", monospace')
    new TerminalContextualShapingAddon().activate(other.terminal)
    expect(other.getRegisteredJoiner()('supersonic')).toEqual([])
  })

  it('re-checks the font on every call so font changes apply without re-activation', () => {
    new TerminalContextualShapingAddon().activate(harness.terminal)
    const joiner = harness.getRegisteredJoiner()

    expect(joiner('supersonic')).toEqual([[0, 10]])
    harness.setFontFamily('"SF Mono", monospace')
    expect(joiner('supersonic')).toEqual([])
    harness.setFontFamily('Fast Mono')
    expect(joiner('supersonic')).toEqual([[0, 10]])
  })

  it('refreshes visible rows on activate and deregisters on dispose', () => {
    const addon = new TerminalContextualShapingAddon()
    addon.activate(harness.terminal)

    expect(harness.refresh).toHaveBeenCalledWith(0, 23)

    addon.dispose()
    expect(harness.deregisterCharacterJoiner).toHaveBeenCalledWith(5)
  })
})
