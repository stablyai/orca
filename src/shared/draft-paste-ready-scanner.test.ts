import { describe, expect, it } from 'vitest'
import { createDraftPasteReadyScanner } from './draft-paste-ready-scanner'
import { OPENCODE_AGENT_ROW_GRACE_MS } from './opencode-agent-row-scanner'

const DECSET_BRACKETED_PASTE = '\x1b[?2004h'
const DECRST_BRACKETED_PASTE = '\x1b[?2004l'
const SHOW_CURSOR = '\x1b[?25h'
const HIDE_CURSOR = '\x1b[?25l'
const ALT_SCREEN_ENTER = '\x1b[?1049h'

describe('createDraftPasteReadyScanner', () => {
  describe('render-cursor-after-bracketed-paste (opencode / mimo-code)', () => {
    it('never joins a show-cursor across a chunk seam from bytes it already scanned', () => {
      // Why: the stream holds only a hide-cursor; re-reading carried chars used to assemble a show.
      const scanner = createDraftPasteReadyScanner('render-cursor-after-bracketed-paste')
      expect(scanner.observe(DECSET_BRACKETED_PASTE).ready).toBe(false)
      expect(scanner.observe('Search \x1b[?25').ready).toBe(false)
      expect(scanner.observe('l more text').ready).toBe(false)
    })
  })

  describe('opencode-agent-row', () => {
    // OpenCode 2.0.21 cold-start shape: row-25 box corner, then row-24 agent/model text.
    const frame = (body: string): string =>
      `\x1b[?2026h${HIDE_CURSOR}${body}\x1b[22;27H${SHOW_CURSOR}\x1b[?2026l`
    const BOX = `${ALT_SCREEN_ENTER}${DECSET_BRACKETED_PASTE}${frame(
      '\x1b[21;24H┃\x1b[22;24H┃\x1b[23;24H┃\x1b[24;24H┃\x1b[25;24H╹'
    )}`
    const AGENT_ROW = frame('\x1b[24;27HBuild\x1b[24;33H\u00b7\x1b[24;35HSome Model')

    it('pairs a separator with a later corner only inside the same synchronized frame', () => {
      const scanner = createDraftPasteReadyScanner('opencode-agent-row')
      const separatorFrame = frame('\x1b[23;33H\u00b7')
      const cornerFrame = frame('\x1b[24;24H╹')
      expect(
        scanner.observe(
          `${ALT_SCREEN_ENTER}${DECSET_BRACKETED_PASTE}${separatorFrame}${cornerFrame}`
        ).ready
      ).toBe(false)
    })

    it('withdraws readiness and the grace timer when bracketed paste is turned off', () => {
      const scanner = createDraftPasteReadyScanner('opencode-agent-row')
      expect(scanner.observe(BOX + AGENT_ROW).ready).toBe(true)
      expect(scanner.observe(DECRST_BRACKETED_PASTE)).toEqual({
        ready: false,
        armQuietTimer: false,
        readyAfterMs: null
      })
      const graced = createDraftPasteReadyScanner('opencode-agent-row')
      expect(graced.observe(BOX).readyAfterMs).toBe(OPENCODE_AGENT_ROW_GRACE_MS)
      expect(graced.observe(DECRST_BRACKETED_PASTE).readyAfterMs).toBeNull()
    })
  })
})
