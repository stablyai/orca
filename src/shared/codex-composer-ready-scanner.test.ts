import { describe, expect, it } from 'vitest'
import { createDraftPasteReadyScanner } from './draft-paste-ready-scanner'

const MODES = '\x1b[?2004h\x1b[?1049h'
const BEGIN = '\x1b[?2026h\x1b[?25l'
const END = '\x1b[37;3H\x1b[?25h\x1b[?2026l'
// Geometry from the 0.160.1 startup capture, with synthetic labels.
const PROVISIONAL = `${MODES}${BEGIN}\x1b[37;1H›\x1b[40;3H? for shortcuts${END}`
const LIVE = `${BEGIN}\x1b[39;3HModel high · folder${END}`

describe('Codex fullscreen composer paste gate', () => {
  it('waits for the live footer, then accepts cursor-only redraws', () => {
    const scanner = createDraftPasteReadyScanner('codex-composer-prompt')
    expect(scanner.observe(PROVISIONAL).ready).toBe(false)
    expect(scanner.observe(LIVE).ready).toBe(true)
    expect(scanner.observe(`${BEGIN}${END}`).ready).toBe(true)
  })

  it('does not resolve in the middle of a synchronized frame', () => {
    const scanner = createDraftPasteReadyScanner('codex-composer-prompt')
    scanner.observe(PROVISIONAL)
    expect(scanner.observe(`${BEGIN}\x1b[39;3HModel · folder`).ready).toBe(false)
    expect(scanner.observe(END).ready).toBe(true)
  })

  it.each([']', 'P', 'X', '^', '_'])('ignores a footer inside ESC %s control strings', (kind) => {
    const scanner = createDraftPasteReadyScanner('codex-composer-prompt')
    scanner.observe(PROVISIONAL)
    expect(scanner.observe(`\x1b${kind}0;\x1b[39;3HModel · folder\x1b\\`).ready).toBe(false)
    expect(scanner.observe(LIVE).ready).toBe(true)
  })

  it.each([']', 'P', 'X', '^', '_'])('keeps split ESC %s control strings hidden', (kind) => {
    const scanner = createDraftPasteReadyScanner('codex-composer-prompt')
    scanner.observe(PROVISIONAL)
    const payload = `\x1b${kind}${'x'.repeat(1024)}\x1b[39;3HModel · folder\x1b\\`
    for (const char of payload) {
      expect(scanner.observe(char).ready).toBe(false)
    }
    expect(scanner.observe(LIVE).ready).toBe(true)
  })

  it.each(['\x1b[?2004l', '\x1b[?1049l'])(
    'withdraws the composer when its terminal mode ends (%s)',
    (leave) => {
      const scanner = createDraftPasteReadyScanner('codex-composer-prompt')
      expect(scanner.observe(PROVISIONAL + LIVE + leave).ready).toBe(false)
      expect(scanner.observe('› shell prompt\x1b[?25h').ready).toBe(false)
    }
  )

  it('does not mistake the shortcut hint for a footer after multiline early input', () => {
    const scanner = createDraftPasteReadyScanner('codex-composer-prompt')
    scanner.observe(PROVISIONAL)
    expect(
      scanner.observe(`${BEGIN}\x1b[38;3Hcontinued note\x1b[38;17H\x1b[?25h\x1b[?2026l`).ready
    ).toBe(false)
  })

  it('keeps the reserved footer row when early multiline input contains footer glyphs', () => {
    const scanner = createDraftPasteReadyScanner('codex-composer-prompt')
    scanner.observe(PROVISIONAL)
    expect(
      scanner.observe(
        `${BEGIN}\x1b[35;1H› first line\x1b[36;3H? second line\x1b[37;3Hthird · line\x1b[35;3H\x1b[?25h\x1b[?2026l`
      ).ready
    ).toBe(false)
    expect(scanner.observe(LIVE).ready).toBe(true)
  })
})
