import { readFileSync } from 'node:fs'
import { join } from 'node:path'
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

  describe('antigravity-composer-prompt', () => {
    it('fires on the composer rows when a custom statusLine replaces the hint row', () => {
      const rule = `\x1b[38;2;65;72;104m${'─'.repeat(80)}\x1b[m\r\n`
      // agy 1.5.2 with a two-line command statusLine, after its startup splash.
      const startup = `${DECSET_BRACKETED_PASTE}${ALT_SCREEN_ENTER} ⣾  Signing in...\r\ncustom-status-one\x1b[?1049l\r\n\n${rule}\x1b[38;2;122;162;247m>\x1b[m\r\n${rule}custom-status-one\r\ncustom-status-two\r\x1b[3A\x1b[2C${SHOW_CURSOR}`
      expect(
        createDraftPasteReadyScanner('antigravity-composer-prompt').observe(startup).ready
      ).toBe(true)
      expect(
        createDraftPasteReadyScanner('antigravity-composer-prompt').observe(
          startup.replace(DECSET_BRACKETED_PASTE, '')
        ).ready
      ).toBe(false)
    })

    it('never arms the quiet window from the shell prompt that launches agy (#18088)', () => {
      const scanner = createDraftPasteReadyScanner('antigravity-composer-prompt')
      // zsh enables paste at its prompt, echoes the command, then disables paste before exec.
      expect(
        scanner.observe(`${DECSET_BRACKETED_PASTE}% agy '--dangerously-skip-permissions'`)
      ).toEqual({ ready: false, armQuietTimer: false })
      expect(scanner.observe(`${DECRST_BRACKETED_PASTE}\r\r\n? for shortcuts`).ready).toBe(false)
    })
  })

  describe('bob-composer-prompt', () => {
    const POWERLEVEL10K_PROMPT = '░▒▓    ~/Workspace/orca-bob  on   bob-integration \r\n❯ '
    const BOB_COMPOSER_PREFIX = 'Build Anything, @ for context'

    it('resolves on the composer prefix without a terminal-mode anchor', () => {
      const scanner = createDraftPasteReadyScanner('bob-composer-prompt')
      expect(scanner.observe('Bob startup output without a composer')).toEqual({
        ready: false,
        armQuietTimer: false
      })
      expect(scanner.observe(BOB_COMPOSER_PREFIX)).toEqual({
        ready: true,
        armQuietTimer: false
      })
    })

    // Why: Bob 2.0.5+ translates the placeholder per the user's locale.
    it('resolves on a translated composer prefix', () => {
      const scanner = createDraftPasteReadyScanner('bob-composer-prompt')
      expect(scanner.observe('❯ 何でも作成、@ でコンテキスト、/ でコマンド、$ で Skill')).toEqual({
        ready: true,
        armQuietTimer: false
      })
    })

    it('does not treat a Powerlevel10k prompt as Bob readiness', () => {
      const scanner = createDraftPasteReadyScanner('bob-composer-prompt')
      expect(scanner.observe(POWERLEVEL10K_PROMPT)).toEqual({
        ready: false,
        armQuietTimer: false
      })
    })

    it('replays both committed Bob captures without generic readiness anchors', () => {
      for (const fixture of ['bob-approval-command.txt', 'bob-approval-subagent.txt']) {
        const capture = readFileSync(
          join(__dirname, '../main/runtime/__fixtures__', fixture),
          'utf8'
        )
        expect(capture).toContain(BOB_COMPOSER_PREFIX)
        expect(capture).not.toContain(DECSET_BRACKETED_PASTE)
        expect(capture).not.toContain(ALT_SCREEN_ENTER)
        expect(createDraftPasteReadyScanner('bob-composer-prompt').observe(capture)).toEqual({
          ready: true,
          armQuietTimer: false
        })
      }
    })

    it('detects the composer prefix split across PTY chunks', () => {
      for (let split = 1; split < BOB_COMPOSER_PREFIX.length; split += 1) {
        const scanner = createDraftPasteReadyScanner('bob-composer-prompt')
        expect(scanner.observe(BOB_COMPOSER_PREFIX.slice(0, split))).toEqual({
          ready: false,
          armQuietTimer: false
        })
        expect(scanner.observe(BOB_COMPOSER_PREFIX.slice(split))).toEqual({
          ready: true,
          armQuietTimer: false
        })
      }
    })
  })
})
