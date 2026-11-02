import { describe, expect, it } from 'vitest'
import { createDraftPasteReadyScanner, resolvePasteReadySignal } from './draft-paste-ready-scanner'
import { OPENCODE_AGENT_ROW_GRACE_MS } from './opencode-agent-row-scanner'
import { TUI_AGENT_CONFIG } from './tui-agent-config'

const DECSET_BRACKETED_PASTE = '\x1b[?2004h'
const DECRST_BRACKETED_PASTE = '\x1b[?2004l'
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
      // OpenCode is silent 1.5–2s after enabling paste before composer mount; cursor gating must not arm an early quiet timer.
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
      // Remote waiters replay cached paste/cursor markers in one observe call; combined buffers must resolve.
      const scanner = createDraftPasteReadyScanner('render-cursor-after-bracketed-paste')
      expect(
        scanner.observe(`banner\n${DECSET_BRACKETED_PASTE}composer\n${SHOW_CURSOR}rest`)
      ).toEqual({ ready: true, armQuietTimer: false })
    })

    it('detects a bracketed-paste handshake split across a chunk boundary', () => {
      // Rejoin handshake bytes split across PTY packets before cursor gating.
      const scanner = createDraftPasteReadyScanner('render-cursor-after-bracketed-paste')
      expect(scanner.observe('\x1b[?20')).toEqual({ ready: false, armQuietTimer: false })
      expect(scanner.observe('04h')).toEqual({ ready: false, armQuietTimer: false })
      expect(scanner.observe(SHOW_CURSOR)).toEqual({ ready: true, armQuietTimer: false })
    })

    it('detects show-cursor split across a later chunk boundary', () => {
      const scanner = createDraftPasteReadyScanner('render-cursor-after-bracketed-paste')
      scanner.observe(DECSET_BRACKETED_PASTE)
      expect(scanner.observe('render noise \x1b[?')).toEqual({ ready: false, armQuietTimer: false })
      expect(scanner.observe('25h')).toEqual({ ready: true, armQuietTimer: false })
    })

    it('never arms the quiet window during the silent pre-composer gap', () => {
      const scanner = createDraftPasteReadyScanner('render-cursor-after-bracketed-paste')
      scanner.observe(DECSET_BRACKETED_PASTE)
      // Wait for show-cursor within hard timeout; startup silence must not pre-empt composer mount.
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

    it('never joins a show-cursor across a chunk seam from bytes it already scanned', () => {
      // Why: the stream holds only a hide-cursor; re-reading carried chars used to assemble a show.
      const scanner = createDraftPasteReadyScanner('render-cursor-after-bracketed-paste')
      expect(scanner.observe(DECSET_BRACKETED_PASTE).ready).toBe(false)
      expect(scanner.observe('Search \x1b[?25').ready).toBe(false)
      expect(scanner.observe('l more text').ready).toBe(false)
    })

    it('ignores a show-cursor after the shell turns bracketed paste back off to run a command', () => {
      // zsh disables paste on accept-line before launcher spinner cursor toggles (synthetic).
      const scanner = createDraftPasteReadyScanner('render-cursor-after-bracketed-paste')
      expect(scanner.observe(`${DECSET_BRACKETED_PASTE}% opencode`).ready).toBe(false)
      expect(scanner.observe(`${DECRST_BRACKETED_PASTE}\r\n`).ready).toBe(false)
      expect(scanner.observe(`${HIDE_CURSOR}resolving${SHOW_CURSOR}`).ready).toBe(false)
      expect(scanner.observe(`${DECSET_BRACKETED_PASTE}${SHOW_CURSOR}`)).toEqual({
        ready: true,
        armQuietTimer: false
      })
    })

    it('ignores show-cursor that appears before bracketed paste is enabled', () => {
      const scanner = createDraftPasteReadyScanner('render-cursor-after-bracketed-paste')
      expect(scanner.observe(SHOW_CURSOR)).toEqual({ ready: false, armQuietTimer: false })
      expect(scanner.observe(DECSET_BRACKETED_PASTE)).toEqual({
        ready: false,
        armQuietTimer: false
      })
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
    const GRACE = { ready: false, armQuietTimer: false, readyAfterMs: OPENCODE_AGENT_ROW_GRACE_MS }

    it('is not ready on the input box and its cursor alone, and asks for the grace timer', () => {
      const scanner = createDraftPasteReadyScanner('opencode-agent-row')
      expect(scanner.observe(BOX)).toEqual(GRACE)
    })

    it('is ready once the row directly above the box corner paints its separator', () => {
      const scanner = createDraftPasteReadyScanner('opencode-agent-row')
      scanner.observe(BOX)
      expect(scanner.observe(AGENT_ROW)).toEqual({
        ready: true,
        armQuietTimer: false,
        readyAfterMs: null
      })
    })

    it('is ready when OpenCode 1 paints the row before the corner in the same frame', () => {
      const scanner = createDraftPasteReadyScanner('opencode-agent-row')
      const opencode1Box = frame('\x1b[23;27HBuild\x1b[23;33H\u00b7\x1b[24;24H╹')
      expect(
        scanner.observe(`${ALT_SCREEN_ENTER}${DECSET_BRACKETED_PASTE}${opencode1Box}`).ready
      ).toBe(true)
    })

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

    it('ignores a separator in the footer path under the box', () => {
      const scanner = createDraftPasteReadyScanner('opencode-agent-row')
      scanner.observe(BOX)
      expect(scanner.observe(frame('\x1b[26;24H~/col\u00b7lecció/work'))).toEqual(GRACE)
    })

    it('ignores a separator in a session tab title', () => {
      const scanner = createDraftPasteReadyScanner('opencode-agent-row')
      scanner.observe(BOX)
      expect(scanner.observe(frame('\x1b[1;4Hx\x1b[1;5H\u00b7\x1b[1;6Hy'))).toEqual(GRACE)
    })

    it('ignores a separator a shell prompt draws before OpenCode enters the alternate screen', () => {
      const scanner = createDraftPasteReadyScanner('opencode-agent-row')
      expect(
        scanner.observe(
          `${DECSET_BRACKETED_PASTE}~ \u00b7 main % opencode${DECRST_BRACKETED_PASTE}`
        )
      ).toEqual({ ready: false, armQuietTimer: false, readyAfterMs: null })
      expect(scanner.observe(BOX).ready).toBe(false)
    })

    it('does not keep a row from an earlier alternate-screen session', () => {
      const scanner = createDraftPasteReadyScanner('opencode-agent-row')
      expect(scanner.observe(BOX + AGENT_ROW).ready).toBe(true)
      expect(scanner.observe(ALT_SCREEN_LEAVE).ready).toBe(false)
      expect(scanner.observe(BOX)).toEqual(GRACE)
    })

    it('does not latch a part an earlier session established and then revoked', () => {
      // Probe preceding sessions: an alt-screen app leaves after a separator; a shell toggles paste/cursor off.
      const leftApp = createDraftPasteReadyScanner('opencode-agent-row')
      leftApp.observe(`${ALT_SCREEN_ENTER}x \u00b7 y${ALT_SCREEN_LEAVE}`)
      expect(leftApp.observe(BOX)).toEqual(GRACE)
      const shell = createDraftPasteReadyScanner('opencode-agent-row')
      shell.observe(`${DECSET_BRACKETED_PASTE}% ${SHOW_CURSOR}${DECRST_BRACKETED_PASTE}`)
      expect(
        shell.observe(`${ALT_SCREEN_ENTER}${DECSET_BRACKETED_PASTE}footer \u00b7 path`).ready
      ).toBe(false)
    })

    it('withdraws the grace when OpenCode leaves the alternate screen before its row', () => {
      const scanner = createDraftPasteReadyScanner('opencode-agent-row')
      expect(scanner.observe(BOX)).toEqual(GRACE)
      const shellPrompt = `${DECSET_BRACKETED_PASTE}% ${SHOW_CURSOR}`
      expect(scanner.observe(`${ALT_SCREEN_LEAVE}${shellPrompt}`)).toEqual({
        ready: false,
        armQuietTimer: false,
        readyAfterMs: null
      })
      expect(scanner.observe(BOX)).toEqual(GRACE)
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

    it('needs the box cursor shown while bracketed paste is held, not one a shell showed', () => {
      const scanner = createDraftPasteReadyScanner('opencode-agent-row')
      scanner.observe(`${DECSET_BRACKETED_PASTE}% ${SHOW_CURSOR}${DECRST_BRACKETED_PASTE}`)
      const rowWithoutCursor = '\x1b[25;24H╹\x1b[24;33H\u00b7'
      expect(
        scanner.observe(`${ALT_SCREEN_ENTER}${DECSET_BRACKETED_PASTE}${rowWithoutCursor}`).ready
      ).toBe(false)
    })

    it('never arms the quiet window', () => {
      const scanner = createDraftPasteReadyScanner('opencode-agent-row')
      expect(scanner.observe(BOX).armQuietTimer).toBe(false)
      expect(scanner.observe('more frames').armQuietTimer).toBe(false)
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
      // Shells also draw ❯ under paste mode; require alt-screen ownership to avoid pasting into shell. Keep the default quiet floor.
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
      // Differential rendering paints the glyph once; late observers need quiet fallback after startup settles.
      const scanner = createDraftPasteReadyScanner('grok-composer-prompt')
      scanner.observe(GROK_ALT_SCREEN_ENTER)
      expect(scanner.observe('logo shimmer frame')).toEqual({ ready: false, armQuietTimer: true })
    })

    it('arms the quiet window from DECSET 2004 when grok renders inline', () => {
      // Inline/minimal grok lacks 1049h; arm quiet from 2004 or main drops the draft.
      const scanner = createDraftPasteReadyScanner('grok-composer-prompt')
      expect(scanner.observe(DECSET_BRACKETED_PASTE)).toEqual({ ready: false, armQuietTimer: true })
      expect(scanner.observe(GROK_COMPOSER_FRAME)).toEqual({ ready: false, armQuietTimer: true })
    })

    it('does not treat a legacy-console `> ` prompt as the glyph', () => {
      // Legacy Windows grok uses generic > instead of ❯, so rely on quiet fallback.
      const scanner = createDraftPasteReadyScanner('grok-composer-prompt')
      scanner.observe(GROK_ALT_SCREEN_ENTER)
      expect(scanner.observe('\x1b[38;2;80;80;88m│\x1b[0m> ')).toEqual({
        ready: false,
        armQuietTimer: true
      })
    })

    it('disarms when grok leaves the alternate screen before painting a composer', () => {
      // An exited grok returns alt-screen ownership to shell; revoke the glyph anchor before shell draws ❯.
      const scanner = createDraftPasteReadyScanner('grok-composer-prompt')
      scanner.observe(GROK_ALT_SCREEN_ENTER)
      expect(scanner.observe(GROK_ALT_SCREEN_LEAVE)).toEqual({
        ready: false,
        armQuietTimer: true
      })
      expect(scanner.observe(`\x1b[32m❯\x1b[0m `)).toEqual({ ready: false, armQuietTimer: true })
    })

    it('ignores a shell prompt after an rc-file program used the alternate screen', () => {
      // rc-file pagers may use/leave alt screen before grok starts; their anchor cannot authorize shell prompts.
      const scanner = createDraftPasteReadyScanner('grok-composer-prompt')
      expect(
        scanner.observe(`rc pager${GROK_ALT_SCREEN_ENTER}paged${GROK_ALT_SCREEN_LEAVE}`)
      ).toEqual({ ready: false, armQuietTimer: true })
      expect(scanner.observe(`${DECSET_BRACKETED_PASTE}\x1b[32m❯\x1b[0m grok\r\n`)).toEqual({
        ready: false,
        armQuietTimer: true
      })
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

  describe('a stream that never carries DECSET 2004', () => {
    // These signals require 2004; lost remote replay/ConPTY handshakes reach hard timeout (terminal-agent-paste-bracketing.ts).
    const ANCHORLESS_OPENCODE_FRAME = `${HIDE_CURSOR}\x1b[2J\x1b[H opencode ${SHOW_CURSOR}`

    it('never reports opencode ready from show-cursor frames alone', () => {
      const scanner = createDraftPasteReadyScanner('render-cursor-after-bracketed-paste')
      for (let frame = 0; frame < 5; frame += 1) {
        expect(scanner.observe(ANCHORLESS_OPENCODE_FRAME)).toEqual({
          ready: false,
          armQuietTimer: false
        })
      }
    })

    it('never arms the default quiet window either', () => {
      const scanner = createDraftPasteReadyScanner('render-quiet-after-bracketed-paste')
      expect(scanner.observe(ANCHORLESS_OPENCODE_FRAME)).toEqual({
        ready: false,
        armQuietTimer: false
      })
    })

    it('never reports the Codex composer glyph ready without its anchor', () => {
      const scanner = createDraftPasteReadyScanner('codex-composer-prompt')
      expect(scanner.observe(`${ALT_SCREEN_ENTER}${CODEX_PROMPT}`)).toEqual({
        ready: false,
        armQuietTimer: false
      })
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

describe('resolvePasteReadySignal', () => {
  it.each(['opencode', 'opencode2'] as const)(
    '%s: only a paste that Enter follows waits for the agent row',
    (agent) => {
      expect(resolvePasteReadySignal(TUI_AGENT_CONFIG[agent], false)).toBe(
        'render-cursor-after-bracketed-paste'
      )
      expect(resolvePasteReadySignal(TUI_AGENT_CONFIG[agent], true)).toBe('opencode-agent-row')
    }
  )

  it('falls back to the draft signal, then the quiet window', () => {
    expect(resolvePasteReadySignal(TUI_AGENT_CONFIG.codex, true)).toBe('codex-composer-prompt')
    expect(resolvePasteReadySignal(null, true)).toBe('render-quiet-after-bracketed-paste')
  })
})
