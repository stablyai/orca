import { expect, it } from 'vitest'
import { nextQueryCandidate } from './pty-startup-query'

const PINNED = { kitty: false, appearance: true }

it("skips SGR and other public CSIs on a pinned PTY's hot path, without parsing them", () => {
  const sgr = '\x1b[31mred\x1b[0m \x1b[1;32mgreen\x1b[0m \x1b[2K\x1b[H'.repeat(100)

  expect(nextQueryCandidate(sgr, 0, PINNED)).toBe(-1)
  expect(nextQueryCandidate(sgr, 0, { kitty: true, appearance: false })).toBe(-1)
})

it('stops at an OSC, a private CSI, or an ESC / `ESC [` a read ends on', () => {
  expect(nextQueryCandidate('\x1b[0mx\x1b]11;?\x07', 0, PINNED)).toBe(5)
  expect(nextQueryCandidate('\x1b[0mx\x1b[?996n', 0, PINNED)).toBe(5)
  expect(nextQueryCandidate('\x1b[0mx\x1b', 0, PINNED)).toBe(5)
  expect(nextQueryCandidate('\x1b[0mx\x1b[', 0, PINNED)).toBe(5)
})
