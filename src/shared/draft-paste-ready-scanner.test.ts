import { describe, expect, it } from 'vitest'
import { createDraftPasteReadyScanner } from './draft-paste-ready-scanner'

const DECSET_BRACKETED_PASTE = '\x1b[?2004h'
const SHOW_CURSOR = '\x1b[?25h'
const HIDE_CURSOR = '\x1b[?25l'
const CODEX_PROMPT = '\x1b[1m›\x1b[0m Ask Codex to do anything'
const CODEX_DYNAMIC_PROMPT = '\x1b[1m›\x1b[0m Implement {feature}'
const ALT_SCREEN_ENTER = '\x1b[?1049h'
const ALT_SCREEN_LEAVE = '\x1b[?1049l'
const GROK_ALT_SCREEN_ENTER = '\x1b[?1049h\x1b[?2004h\x1b[?25l'
const GROK_ALT_SCREEN_LEAVE = '\x1b[?1049l\x1b[?25h'
const GROK_COMPOSER_FRAME = '\x1b[38;2;80;80;88m│\x1b[38;2;200;200;200m❯ \x1b[0m'

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

  describe('codex-composer-prompt', () => {
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

    it('is ready when Codex renders its composer before enabling bracketed paste', () => {
      const scanner = createDraftPasteReadyScanner('codex-composer-prompt')
      expect(scanner.observe(`${ALT_SCREEN_ENTER}${CODEX_DYNAMIC_PROMPT}`)).toEqual({
        ready: false,
        armQuietTimer: false
      })
      expect(scanner.observe(DECSET_BRACKETED_PASTE)).toEqual({
        ready: true,
        armQuietTimer: false
      })
    })

    it('forgets a pre-anchor glyph when Codex leaves the alternate screen', () => {
      const scanner = createDraftPasteReadyScanner('codex-composer-prompt')
      scanner.observe(`${ALT_SCREEN_ENTER}${CODEX_DYNAMIC_PROMPT}${ALT_SCREEN_LEAVE}`)
      expect(scanner.observe(DECSET_BRACKETED_PASTE)).toEqual({
        ready: false,
        armQuietTimer: false
      })
    })

    it('ignores a stale shell glyph before bracketed paste is enabled', () => {
      const scanner = createDraftPasteReadyScanner('codex-composer-prompt')
      expect(scanner.observe('› codex\r\nstartup output')).toEqual({
        ready: false,
        armQuietTimer: false
      })
      expect(scanner.observe(DECSET_BRACKETED_PASTE)).toEqual({
        ready: false,
        armQuietTimer: false
      })
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

  describe('grok-composer-prompt', () => {
    it('is ready on the composer glyph after the alternate-screen switch', () => {
      const scanner = createDraftPasteReadyScanner('grok-composer-prompt')
      expect(scanner.observe(GROK_ALT_SCREEN_ENTER)).toEqual({ ready: false, armQuietTimer: true })
      expect(scanner.observe(GROK_COMPOSER_FRAME)).toEqual({ ready: true, armQuietTimer: false })
    })

    it('ignores a shell prompt glyph emitted before grok takes the screen', () => {
      // Why: `❯` is starship's / pure's default prompt too, and that prompt —
      // with its own DECSET 2004 — renders in the normal buffer while the shell
      // still owns the PTY. Firing there would paste the draft into the shell.
      // The shell's 2004 still arms the quiet floor, exactly as it does today
      // for every agent on the default signal.
      const scanner = createDraftPasteReadyScanner('grok-composer-prompt')
      expect(scanner.observe(`${DECSET_BRACKETED_PASTE}\x1b[32m❯\x1b[0m grok\r\n`)).toEqual({
        ready: false,
        armQuietTimer: true
      })
      expect(scanner.observe(GROK_ALT_SCREEN_ENTER)).toEqual({ ready: false, armQuietTimer: true })
      expect(scanner.observe(GROK_COMPOSER_FRAME)).toEqual({ ready: true, armQuietTimer: false })
    })

    it('resolves from a single replayed buffer holding both markers (SSH/remote replay path)', () => {
      const scanner = createDraftPasteReadyScanner('grok-composer-prompt')
      expect(scanner.observe(`${GROK_ALT_SCREEN_ENTER}logo frames${GROK_COMPOSER_FRAME}`)).toEqual({
        ready: true,
        armQuietTimer: false
      })
    })

    it('keeps arming the quiet window so a missed composer frame still delivers', () => {
      // Why: grok renders differentially — the glyph is painted once, so a
      // scanner that attached after that frame would otherwise wait out the
      // caller's hard timeout. Output only goes quiet once startup settles.
      const scanner = createDraftPasteReadyScanner('grok-composer-prompt')
      scanner.observe(GROK_ALT_SCREEN_ENTER)
      expect(scanner.observe('logo shimmer frame')).toEqual({ ready: false, armQuietTimer: true })
    })

    it('arms the quiet window from DECSET 2004 when grok renders inline', () => {
      // Why: `--no-alt-screen` / `[ui] screen_mode = "minimal"` emits no 1049h,
      // so the glyph never anchors. The quiet window must still arm off 2004 or
      // readiness never resolves and the main-process caller drops the draft.
      const scanner = createDraftPasteReadyScanner('grok-composer-prompt')
      expect(scanner.observe(DECSET_BRACKETED_PASTE)).toEqual({ ready: false, armQuietTimer: true })
      expect(scanner.observe(GROK_COMPOSER_FRAME)).toEqual({ ready: false, armQuietTimer: true })
    })

    it('does not treat a legacy-console `> ` prompt as the glyph', () => {
      // grok draws `> ` instead of `❯` on legacy Windows consoles; it is too
      // generic to match, so those launches ride the quiet window.
      const scanner = createDraftPasteReadyScanner('grok-composer-prompt')
      scanner.observe(GROK_ALT_SCREEN_ENTER)
      expect(scanner.observe('\x1b[38;2;80;80;88m│\x1b[0m> ')).toEqual({
        ready: false,
        armQuietTimer: true
      })
    })

    it('disarms when grok leaves the alternate screen before painting a composer', () => {
      // Why: grok entering the alt screen and then dying hands the terminal back to
      // the shell. A latched anchor would treat the shell's `❯` prompt as grok's
      // composer and paste the draft into the shell.
      const scanner = createDraftPasteReadyScanner('grok-composer-prompt')
      scanner.observe(GROK_ALT_SCREEN_ENTER)
      expect(scanner.observe(GROK_ALT_SCREEN_LEAVE)).toEqual({
        ready: false,
        armQuietTimer: true
      })
      expect(scanner.observe(`\x1b[32m❯\x1b[0m `)).toEqual({ ready: false, armQuietTimer: true })
    })

    it('ignores a shell prompt after an rc-file program used the alternate screen', () => {
      // Why: a pager/editor launched from the user's shell rc enters and leaves the
      // alt screen before grok is even launched; the prompt that follows is the
      // shell's, so the anchor must not survive the leave.
      const scanner = createDraftPasteReadyScanner('grok-composer-prompt')
      expect(
        scanner.observe(`rc pager${GROK_ALT_SCREEN_ENTER}paged${GROK_ALT_SCREEN_LEAVE}`)
      ).toEqual({ ready: false, armQuietTimer: true })
      expect(scanner.observe(`${DECSET_BRACKETED_PASTE}\x1b[32m❯\x1b[0m grok\r\n`)).toEqual({
        ready: false,
        armQuietTimer: true
      })
      // grok's own launch still resolves normally afterwards.
      expect(scanner.observe(GROK_ALT_SCREEN_ENTER)).toEqual({ ready: false, armQuietTimer: true })
      expect(scanner.observe(GROK_COMPOSER_FRAME)).toEqual({ ready: true, armQuietTimer: false })
    })

    it('ignores a glyph that precedes the alt-screen switch inside one chunk', () => {
      const scanner = createDraftPasteReadyScanner('grok-composer-prompt')
      expect(scanner.observe(`❯ ${GROK_ALT_SCREEN_ENTER}`)).toEqual({
        ready: false,
        armQuietTimer: true
      })
    })

    it('does not fire on a glyph that lands after the leave inside one chunk', () => {
      const scanner = createDraftPasteReadyScanner('grok-composer-prompt')
      scanner.observe(GROK_ALT_SCREEN_ENTER)
      expect(scanner.observe(`${GROK_ALT_SCREEN_LEAVE}\x1b[32m❯\x1b[0m `)).toEqual({
        ready: false,
        armQuietTimer: true
      })
    })

    it('detects the alt-screen anchor split across a chunk boundary', () => {
      const scanner = createDraftPasteReadyScanner('grok-composer-prompt')
      expect(scanner.observe('\x1b[?10')).toEqual({ ready: false, armQuietTimer: false })
      expect(scanner.observe('49h')).toEqual({ ready: false, armQuietTimer: false })
      expect(scanner.observe(GROK_COMPOSER_FRAME)).toEqual({ ready: true, armQuietTimer: false })
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
