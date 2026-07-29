import { describe, expect, it } from 'vitest'
import { createDraftPasteReadyScanner } from './draft-paste-ready-scanner'

const DECSET_BRACKETED_PASTE = '\x1b[?2004h'
const SHOW_CURSOR = '\x1b[?25h'
const HIDE_CURSOR = '\x1b[?25l'
const CODEX_PROMPT = '\x1b[1m›\x1b[0m Ask Codex to do anything'

describe('createDraftPasteReadyScanner', () => {
  describe('render-cursor-after-bracketed-paste (opencode / mimo-code)', () => {
    it('is ready when show-cursor renders after bracketed paste in one chunk', () => {
      const scanner = createDraftPasteReadyScanner('render-cursor-after-bracketed-paste')
      expect(scanner.observe(`${DECSET_BRACKETED_PASTE}${SHOW_CURSOR}`)).toEqual({
        ready: true,
        armQuietTimer: false
      })
    })

    it('does not fire on bracketed paste alone, then fires once show-cursor arrives', () => {
      const scanner = createDraftPasteReadyScanner('render-cursor-after-bracketed-paste')
      // Why: opencode enables bracketed paste ~1.5-2s before its composer mounts
      // and stays SILENT in between. The cursor gates delivery and must NOT arm
      // the quiet window, which would otherwise fire during that silent gap and
      // paste before the composer exists.
      expect(scanner.observe(DECSET_BRACKETED_PASTE)).toEqual({
        ready: false,
        armQuietTimer: false
      })
      expect(scanner.observe('startup banner output')).toEqual({
        ready: false,
        armQuietTimer: false
      })
      expect(scanner.observe(SHOW_CURSOR)).toEqual({ ready: true, armQuietTimer: false })
    })

    it('resolves from a single replayed buffer holding both markers (SSH/remote replay path)', () => {
      // Why: the runtime waiter feeds recentPtyOutputById as one observe() call
      // when the agent emitted 2004 + show-cursor before the subscription
      // attached; a single combined buffer must still resolve.
      const scanner = createDraftPasteReadyScanner('render-cursor-after-bracketed-paste')
      expect(
        scanner.observe(`banner\n${DECSET_BRACKETED_PASTE}composer\n${SHOW_CURSOR}rest`)
      ).toEqual({ ready: true, armQuietTimer: false })
    })

    it('detects a bracketed-paste handshake split across a chunk boundary', () => {
      // Why: the pre-handshake `recent` ring must reassemble a \x1b[?2004h that
      // straddles two PTY packets, or cursor-gated readiness breaks for
      // fragmented startup output.
      const scanner = createDraftPasteReadyScanner('render-cursor-after-bracketed-paste')
      expect(scanner.observe('\x1b[?20')).toEqual({ ready: false, armQuietTimer: false })
      expect(scanner.observe('04h')).toEqual({ ready: false, armQuietTimer: false })
      expect(scanner.observe(SHOW_CURSOR)).toEqual({ ready: true, armQuietTimer: false })
    })

    it('detects show-cursor split across a later chunk boundary', () => {
      const scanner = createDraftPasteReadyScanner('render-cursor-after-bracketed-paste')
      scanner.observe(DECSET_BRACKETED_PASTE)
      // The escape sequence is split mid-bytes across two separate chunks.
      expect(scanner.observe('render noise \x1b[?')).toEqual({ ready: false, armQuietTimer: false })
      expect(scanner.observe('25h')).toEqual({ ready: true, armQuietTimer: false })
    })

    it('never arms the quiet window during the silent pre-composer gap', () => {
      const scanner = createDraftPasteReadyScanner('render-cursor-after-bracketed-paste')
      scanner.observe(DECSET_BRACKETED_PASTE)
      // Why: opencode is silent here; arming the quiet window would fire before
      // the composer mounts and pre-empt the cursor signal (the original bug).
      // Delivery waits for show-cursor, bounded by the caller's hard timeout.
      for (let i = 0; i < 5; i += 1) {
        expect(scanner.observe(`setup output ${i}`)).toEqual({ ready: false, armQuietTimer: false })
      }
    })

    it('does not treat hide-cursor as the ready signal', () => {
      const scanner = createDraftPasteReadyScanner('render-cursor-after-bracketed-paste')
      // \x1b[?25l (hide) must not be mistaken for \x1b[?25h (show).
      expect(scanner.observe(`${DECSET_BRACKETED_PASTE}${HIDE_CURSOR}`)).toEqual({
        ready: false,
        armQuietTimer: false
      })
    })

    it('ignores show-cursor that appears before bracketed paste is enabled', () => {
      const scanner = createDraftPasteReadyScanner('render-cursor-after-bracketed-paste')
      // A pre-handshake cursor toggle must not trip readiness.
      expect(scanner.observe(SHOW_CURSOR)).toEqual({ ready: false, armQuietTimer: false })
      expect(scanner.observe(DECSET_BRACKETED_PASTE)).toEqual({
        ready: false,
        armQuietTimer: false
      })
    })
  })

  describe('codex-composer-prompt (unchanged behavior)', () => {
    it('is ready on the composer glyph after bracketed paste and never arms the quiet timer', () => {
      const scanner = createDraftPasteReadyScanner('codex-composer-prompt')
      expect(scanner.observe(DECSET_BRACKETED_PASTE)).toEqual({
        ready: false,
        armQuietTimer: false
      })
      expect(scanner.observe(CODEX_PROMPT)).toEqual({ ready: true, armQuietTimer: false })
    })

    it('detects the composer glyph inside a large first render chunk', () => {
      const scanner = createDraftPasteReadyScanner('codex-composer-prompt')
      expect(scanner.observe(`${DECSET_BRACKETED_PASTE}${CODEX_PROMPT}${'x'.repeat(900)}`)).toEqual(
        { ready: true, armQuietTimer: false }
      )
    })

    it('never arms the quiet-window fallback', () => {
      const scanner = createDraftPasteReadyScanner('codex-composer-prompt')
      expect(scanner.observe(DECSET_BRACKETED_PASTE)).toEqual({
        ready: false,
        armQuietTimer: false
      })
      expect(scanner.observe('noise')).toEqual({ ready: false, armQuietTimer: false })
    })
  })

  describe('render-quiet-after-bracketed-paste (default)', () => {
    it('arms the quiet timer after bracketed paste and never reports a signal', () => {
      const scanner = createDraftPasteReadyScanner('render-quiet-after-bracketed-paste')
      expect(scanner.observe(DECSET_BRACKETED_PASTE)).toEqual({ ready: false, armQuietTimer: true })
      // Show-cursor is not a signal for the default path; it just keeps arming.
      expect(scanner.observe(SHOW_CURSOR)).toEqual({ ready: false, armQuietTimer: true })
    })

    it('does nothing until bracketed paste is enabled', () => {
      const scanner = createDraftPasteReadyScanner('render-quiet-after-bracketed-paste')
      expect(scanner.observe('pre-handshake output')).toEqual({
        ready: false,
        armQuietTimer: false
      })
    })
  })
})
