import { describe, expect, it } from 'vitest'
import { getAgentLabel as getSharedAgentLabel } from './agent-title-identity'
import { collectAgentTitleEvidence } from './agent-title-evidence'
import { isJcodeIdentityTerminalTitle } from './jcode-terminal-title'
import { detectAgentStatusFromTitle } from './agent-title-status'
import { isOpenCodeNativeTitle } from './opencode-terminal-title'
import {
  getAgentLabel,
  isClaudeAgent,
  isClaudeIdentityFrameTitle,
  isGrokRotatingWorkingTitle,
  resolveExplicitTerminalTitleAgentType,
  resolveTerminalTitleAgentType
} from './terminal-title-agent-type'

describe('Jcode title identity entry points', () => {
  it.each([
    'jcode',
    'jcode Pawprint',
    '🐾 jcode Pawprint',
    '🐾 jcode/desert Pawprint',
    '🐾 jcode/desert Pawprint · work ~1s',
    '🌐 jcode/desert Pawprint · last ~3s',
    '🌐 jcode/meadow Hippo · work ~1m34s',
    '🦨 jcode/castle Skunk',
    '🌐 jcode/castle Skunk · +2 -1 · work ~10s',
    '🌐 jcode/castle Skunk · +2 -1 · last ~10s',
    '🐽 jcode/castle Piglet',
    '🌐 jcode/castle Piglet · work ~13s',
    '🌐 jcode/castle Skunk · +1 -0 · work ~10s',
    '🌐 jcode/castle Skunk · work ~1d2h',
    '🌐 jcode/castle Skunk · last ~1.5s'
  ])('agrees on captured identity %j', (title) => {
    expect(isJcodeIdentityTerminalTitle(title)).toBe(true)
    expect(collectAgentTitleEvidence(title).agent).toBe('jcode')
    expect(getSharedAgentLabel(title)).toBe('Jcode')
    expect(getAgentLabel(title)).toBe('Jcode')
    expect(resolveTerminalTitleAgentType(title)).toBe('jcode')
  })

  it.each([
    'Fix jcode hooks',
    '✳ Fix jcode hooks',
    '✳ jcode hooks',
    '✋ jcode hooks',
    '⏲ jcode hooks',
    '✦ jcode hooks',
    '🐾 jcode hooks',
    'jcode-something-else',
    'jcode/castle Skunk · work ~oops',
    'jcode/castle Skunk · work ~10s · renamed',
    '🌐 Fix the caiea bw-scheduler cache permission EPER… · +436 -46 · work ~53m15s',
    "🌐 Reproduce Glama's TDQS (C 2.9) score locally so … · work ~1m44s"
  ])('never promotes task or lookalike %j to Jcode', (title) => {
    expect(isJcodeIdentityTerminalTitle(title)).toBe(false)
    expect(collectAgentTitleEvidence(title).agent).not.toBe('jcode')
    expect(getSharedAgentLabel(title)).not.toBe('Jcode')
    expect(getAgentLabel(title)).not.toBe('Jcode')
    expect(resolveTerminalTitleAgentType(title)).not.toBe('jcode')
  })

  it.each([
    ['✳ jcode hooks', 'idle'],
    ['✋ jcode hooks', 'permission'],
    ['⏲ jcode hooks', 'working'],
    ['✦ jcode hooks', 'working'],
    ['🐾 jcode hooks', 'idle']
  ] as const)('preserves native glyph activity in %j', (title, status) => {
    expect(detectAgentStatusFromTitle(title)).toBe(status)
  })
})

describe('isGrokRotatingWorkingTitle', () => {
  it('matches Grok working frames regardless of the rotating middle text', () => {
    expect(isGrokRotatingWorkingTitle('⠋ - Waiting for response… - grok')).toBe(true)
    expect(isGrokRotatingWorkingTitle('⠴ - Thinking - grok')).toBe(true)
    expect(isGrokRotatingWorkingTitle('⠦ - Sleep 2s then echo hello… - grok')).toBe(true)
    // Collapsed/stable form must stay matched so re-normalization is idempotent.
    expect(isGrokRotatingWorkingTitle('⠋ grok')).toBe(true)
    expect(isGrokRotatingWorkingTitle('⠋ Grok')).toBe(true)
  })

  it('ignores non-working, non-Grok, and lookalike titles', () => {
    expect(isGrokRotatingWorkingTitle('grok')).toBe(false) // idle bare name, no spinner
    expect(isGrokRotatingWorkingTitle('Fix the auth bug - grok')).toBe(false) // session title, no spinner
    expect(isGrokRotatingWorkingTitle('⠋ debugging grok - claude')).toBe(false) // trailing name is another agent
    expect(isGrokRotatingWorkingTitle('⠋ ~/grok-scratch/ready')).toBe(false) // path fragment, not a trailing token
    expect(isGrokRotatingWorkingTitle('⠋ grokking the plan')).toBe(false) // "grok" not a whole trailing token
    expect(isGrokRotatingWorkingTitle('⠋ Codex')).toBe(false)
    // Task text ending in "grok" is not the Grok frame shape "spinner - phrase - grok".
    expect(isGrokRotatingWorkingTitle('⠋ wire up grok')).toBe(false)
    expect(isGrokRotatingWorkingTitle('⠋ Codex is thinking about grok')).toBe(false)
    expect(isGrokRotatingWorkingTitle('⠋ support for Grok')).toBe(false)
    // Require Grok’s post-spinner delimiter so Claude/Codex task text ending in - grok keeps its identity.
    expect(isGrokRotatingWorkingTitle('⠋ fix the flaky suite - grok')).toBe(false)
    expect(isGrokRotatingWorkingTitle('⠋ review grok integration - claude')).toBe(false)
  })
})

describe('resolveExplicitTerminalTitleAgentType', () => {
  it('maps explicit product-name titles to their TuiAgent id', () => {
    expect(resolveExplicitTerminalTitleAgentType('✳ Claude Code')).toBe('claude')
    expect(resolveExplicitTerminalTitleAgentType('⠋ Codex')).toBe('codex')
    expect(resolveExplicitTerminalTitleAgentType('✦ Gemini CLI')).toBe('gemini')
    expect(resolveExplicitTerminalTitleAgentType('MiMo Code')).toBe('mimo-code')
    expect(resolveExplicitTerminalTitleAgentType('⠋ OpenClaude')).toBe('openclaude')
    expect(resolveExplicitTerminalTitleAgentType('OMP')).toBe('omp')
  })

  it('treats Claude generic status prefixes as activity-only, not identity', () => {
    expect(resolveExplicitTerminalTitleAgentType('✳ investigating startup')).toBeNull()
    expect(resolveExplicitTerminalTitleAgentType('⠸ investigating startup')).toBeNull()
    expect(resolveExplicitTerminalTitleAgentType('. Compare Opencode Vs Orca')).toBeNull()
    expect(resolveExplicitTerminalTitleAgentType('* Review Codex behavior')).toBeNull()
  })

  it('resolves OpenCode native abbreviated session titles before task-text identities', () => {
    expect(resolveExplicitTerminalTitleAgentType('OC | Understand about the plugin')).toBe(
      'opencode'
    )
    expect(resolveExplicitTerminalTitleAgentType('OC | Compare Codex and Claude')).toBe('opencode')
    // Why: Gemini glyphs inside OpenCode session text must not rebrand the tab.
    expect(resolveExplicitTerminalTitleAgentType('OC | ✦ Gemini CLI')).toBe('opencode')
    expect(getSharedAgentLabel('OC | Compare Codex and Claude')).toBe('OpenCode')
    expect(getSharedAgentLabel('OC | ✦ Gemini CLI')).toBe('OpenCode')
    expect(resolveExplicitTerminalTitleAgentType('tmux | OC | ses_123')).toBe('opencode')
    expect(resolveExplicitTerminalTitleAgentType('OC|compact-session')).toBeNull()
    expect(resolveExplicitTerminalTitleAgentType('oc | Understand about the plugin')).toBeNull()
  })

  it('does not find an OpenCode marker inside another agent task title', () => {
    expect(isOpenCodeNativeTitle('⠋ Fix foo | OC | bar')).toBe(false)
    expect(resolveExplicitTerminalTitleAgentType('⠋ Fix foo | OC | bar')).toBeNull()
  })

  it('keeps other agents classified correctly alongside OpenCode native titles', () => {
    expect(resolveExplicitTerminalTitleAgentType('✳ Claude Code')).toBe('claude')
    expect(resolveExplicitTerminalTitleAgentType('⠋ Codex')).toBe('codex')
    expect(resolveExplicitTerminalTitleAgentType('✦ Gemini CLI')).toBe('gemini')
    expect(resolveExplicitTerminalTitleAgentType('Cursor Agent')).toBe('cursor')
    expect(resolveExplicitTerminalTitleAgentType('Pi ready')).toBe('pi')
    expect(resolveExplicitTerminalTitleAgentType('OpenCode ready')).toBe('opencode')
    expect(resolveTerminalTitleAgentType('OC | ⠋ implementing the feature')).toBe('opencode')
    expect(isClaudeAgent('OC | ⠋ implementing the feature')).toBe(false)
    expect(isClaudeAgent('OC | Understand about the plugin')).toBe(false)
  })

  it('still resolves Claude when the title explicitly names Claude', () => {
    expect(resolveExplicitTerminalTitleAgentType('. Claude Code compare Opencode')).toBe('claude')
  })

  // Only explicit Claude identity may replace the owner; task-text mentions do not prove identity (#8940).
  it('separates Claude identity frames from an incidental claude token', () => {
    for (const title of [
      'Claude Code',
      '✳ Claude Code',
      '⠋ Claude Code',
      'claude',
      '. claude',
      'Claude Code ready',
      'Claude - action required',
      // A multiplexer prefix must not read as task text and cost Claude its identity.
      'zsh | ⠋ Claude Code',
      'tmux | dev | Claude Code ready'
    ]) {
      expect(isClaudeIdentityFrameTitle(title)).toBe(true)
    }
    for (const title of [
      '⠋ use Claude Sonnet',
      'OC | ⠋ ask claude about this',
      '⠋ port the claude prompt',
      '. ship it with claude',
      '⠋ claude 스타일로 리팩터',
      '. Claude Code compare Opencode',
      '✳ investigating startup',
      '✳'
    ]) {
      expect(isClaudeIdentityFrameTitle(title)).toBe(false)
    }
  })

  it('returns null for plain shell and unknown titles', () => {
    expect(resolveExplicitTerminalTitleAgentType('Terminal 1')).toBeNull()
    expect(resolveExplicitTerminalTitleAgentType('zsh')).toBeNull()
  })

  // cursor is ordinary task vocabulary; only Cursor’s identity frames can claim the pane.
  it('resolves Cursor by its identity titles, never a bare cursor token', () => {
    expect(resolveExplicitTerminalTitleAgentType('Cursor Agent')).toBe('cursor')
    expect(resolveExplicitTerminalTitleAgentType('⠋ Cursor Agent')).toBe('cursor')
    expect(resolveExplicitTerminalTitleAgentType('Cursor ready')).toBe('cursor')
    expect(resolveExplicitTerminalTitleAgentType('Cursor - action required')).toBe('cursor')
    // A Claude tab whose task text mentions a text cursor is not Cursor identity.
    expect(
      resolveExplicitTerminalTitleAgentType('⠋ preserve cursor visibility across replays')
    ).toBeNull()
    expect(resolveExplicitTerminalTitleAgentType('~/cursor-rules')).toBeNull()
  })
})

describe('resolveTerminalTitleAgentType', () => {
  // Keep Claude activity for cursor mentions while recognizing real Cursor identity titles.
  it('labels cursor-mentioning agent tabs by their true agent, real Cursor as cursor', () => {
    expect(resolveTerminalTitleAgentType('⠋ Cursor Agent')).toBe('cursor')
    expect(resolveTerminalTitleAgentType('Cursor Agent')).toBe('cursor')
    expect(resolveTerminalTitleAgentType('Cursor ready')).toBe('cursor')
    expect(resolveTerminalTitleAgentType('Cursor - action required')).toBe('cursor')
    expect(resolveTerminalTitleAgentType('⠋ preserve cursor visibility across replays')).toBe(
      'claude'
    )
    expect(resolveTerminalTitleAgentType('⠋ Codex: fix cursor offsets')).toBe('codex')
  })
})

// Pin this module’s parallel isClaudeAgent guard directly so it cannot drift from agent-title-identity.ts.
describe('isClaudeAgent', () => {
  it('excludes real Cursor identity titles, keeps cursor-mentioning Claude braille titles', () => {
    expect(isClaudeAgent('⠋ Cursor Agent')).toBe(false)
    expect(isClaudeAgent('Cursor ready')).toBe(false)
    expect(isClaudeAgent('⠋ preserve cursor visibility across replays')).toBe(true)
    expect(isClaudeAgent('⠋ OpenClaude')).toBe(false)
  })
})
