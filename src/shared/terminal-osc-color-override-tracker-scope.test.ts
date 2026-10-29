import { expect, it } from 'vitest'
import { TerminalOscColorOverrideTracker } from './terminal-osc-color-override-tracker'

const BASE = { foreground: '#ffffff', background: '#000000' }

it('tracks palette and cursor SETs only for an owner that answers them', () => {
  const plain = new TerminalOscColorOverrideTracker()
  const pinned = new TerminalOscColorOverrideTracker(true)
  for (const tracker of [plain, pinned]) {
    tracker.scan('\x1b]4;1;#ff0000\x07\x1b]12;#00ff00\x07', () => BASE)
    tracker.resolve(BASE)
  }

  expect(plain.resolvedPaletteColor(1)).toBeUndefined()
  expect(plain.resolvedCursor()).toBeNull()
  expect(pinned.resolvedPaletteColor(1)).toEqual([0xff, 0, 0])
  expect(pinned.resolvedCursor()).toEqual([0, 0xff, 0])
})
