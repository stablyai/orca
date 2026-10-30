import { describe, expect, it } from 'vitest'
import { getAgentLabel as getSharedAgentLabel } from './agent-title-identity'
import { resolveTabAgentFromSignals } from './tab-agent-from-signals'
import { isOpenCodeNativeTitle } from './opencode-terminal-title'
import {
  isClaudeIdentityFrameTitle,
  isGrokRotatingWorkingTitle,
  resolveExplicitTerminalTitleAgentType,
  resolveTerminalTitleAgentType,
  resolveTerminalTitlePolicyAgentType
} from './terminal-title-agent-type'

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
    // Why: Gemini glyphs inside OpenCode session text must not rebrand the tab.
    expect(resolveExplicitTerminalTitleAgentType('OC | ✦ Gemini CLI')).toBe('opencode')
    expect(getSharedAgentLabel('OC | Compare Codex and Claude')).toBe('OpenCode')
    expect(getSharedAgentLabel('OC | ✦ Gemini CLI')).toBe('OpenCode')
    expect(resolveExplicitTerminalTitleAgentType('tmux | OC | ses_123')).toBe('opencode')
    expect(resolveExplicitTerminalTitleAgentType('OC|compact-session')).toBeNull()
    expect(resolveExplicitTerminalTitleAgentType('oc | Understand about the plugin')).toBeNull()
  })

  it.each([
    ['tmux | OC | a | b | c | d | e | f | g | h | Codex', 'opencode'],
    ['tmux | 🐋 a | b | c | d | e | f | g | h | Codex', 'dsh'],
    ['Wrapper | OC | Review Codex - DeepSeek Build', 'opencode'],
    ['user@host: ~/code | OC | ses_123', 'opencode'],
    ['user@[::1]: ~/code | ⠋ OC | ses_123', 'opencode'],
    ['[user@host]: ~/code | Codex: fix parser', 'codex'],
    ['C:\\repo | ⠋ Cursor Agent', 'cursor'],
    ['tmux | Codex: fix parser | a | b | c | d | e | f | g | Claude Code', 'codex'],
    ['tmux | ⠋ fix parser | a | b | c | d | e | f | g | Codex', null],
    ['Plan: migrate | Codex', null],
    ['codex | main | fix parser', null],
    ['OC |\tCodex', 'opencode'],
    ['⠋ - Codex: fix parser - grok', 'grok'],
    ['⠋ Codex: fix parser - grok', null],
    ['tmux | OC | ⠋ - Codex: fix parser - grok', null],
    ['⠋ - OC | Claude Code - DeepSeek Build', 'dsb']
  ] as const)('consumes the actual frame/barrier in %j', (title, agent) => {
    expect(resolveExplicitTerminalTitleAgentType(title)).toBe(agent)
  })

  it.each([0, 1, 8, 9, 200])('keeps ASCII marker barriers after %i wrappers', (depth) => {
    for (const marker of ['.', '*']) {
      for (const payload of ['Droid', 'Grok']) {
        expect(
          resolveExplicitTerminalTitleAgentType(`${'x | '.repeat(depth)}${marker} | ${payload}`)
        ).toBeNull()
      }
    }
  })

  it.each([
    [' . | Grok', null],
    ['x |  * | Droid', null],
    ['.  | Droid', null],
    ['.\t | Grok', null],
    ['*\u00a0 | Droid', null],
    ['x | Grok', 'grok'],
    ['  x | Grok', 'grok'],
    [' | Grok', 'grok'],
    ['   | Grok', 'grok'],
    [' |  | Grok', 'grok'],
    ['', null],
    ...['...', './repo', '.venv', '*.ts'].map((header) => [`${header} | Grok`, 'grok'] as const),
    ['.|Grok', null],
    ['*|Droid', null],
    ['.', null],
    ['*', null],
    ['. Grok', null],
    ['* Grok', null],
    ['. Claude Code', 'claude'],
    ['. | Claude Code', null],
    ['. | OC | ses_1', null],
    ['OC | . | Droid', 'opencode'],
    ['Codex: . | Droid', 'codex'],
    ['⠋ | Grok', null],
    ['⠋ | Droid', 'droid'],
    ['. | Droid - grok', 'grok'],
    ['. | Droid - droid', 'droid'],
    ['. | fix parser - grok', 'grok'],
    ['. | ✦ session | Thinking - grok', 'grok'],
    ['Codex: task - grok', null],
    ['OC | task - grok', null]
  ] as const)(
    'preserves lexical barrier and independent anchor semantics in %j',
    (title, agent) => {
      expect(resolveExplicitTerminalTitleAgentType(title)).toBe(agent)
    }
  )

  it.each([7, 8, 9, 200])('retains frames and barriers after %i actual wrappers', (depth) => {
    const wrappers = 'x | '.repeat(depth)
    const payload = 'a | b | c | d | e | f | g | h | Codex'
    for (const [frame, agent] of [
      [`OC | ${payload}`, 'opencode'],
      [`🐋 ${payload}`, 'dsh'],
      [`Codex: fix parser | ${payload}`, 'codex'],
      [`⠋ fix parser | ${payload}`, null]
    ] as const) {
      expect(resolveExplicitTerminalTitleAgentType(wrappers + frame)).toBe(agent)
    }
  })

  it('does not find an OpenCode marker inside another agent task title', () => {
    expect(isOpenCodeNativeTitle('⠋ Fix foo | OC | bar')).toBe(false)
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

describe('explicit identity admission shared by display and input readers', () => {
  it.each([
    'codex',
    'grok',
    'gemini',
    'copilot',
    'devin',
    'aider',
    'openclaude',
    'claude',
    'jcode',
    'antigravity',
    'droid',
    'hermes',
    'mimo'
  ])('does not identify a task mentioning %s', (name) => {
    expect(resolveExplicitTerminalTitleAgentType(`⠋ fix the ${name} launcher`)).toBeNull()
  })

  // Native/synthetic spellings already recognized by the title parser and its producer fixtures.
  it.each([
    ['Claude Code', 'claude'],
    ['claude.bat working', 'claude'],
    ['claude [working]', 'claude'],
    ['claude ~/p/repo', 'claude'],
    ['codex ~/p/repo', 'codex'],
    ['codex.exe C:\\p\\repo', 'codex'],
    ['⠋ OpenClaude', 'openclaude'],
    ['openclaude.cmd', 'openclaude'],
    ['⠋ Codex: fix cursor offsets', 'codex'],
    ['codex.exe', 'codex'],
    ['✦ Analyzing the repository', 'gemini'],
    ['◇ Gemini CLI', 'gemini'],
    ['✦ Claude Code', 'gemini'],
    ['✦ Codex', 'gemini'],
    ['✦ Codex: fix parser', 'gemini'],
    ['✦ Codex: fix parser | Thinking', 'qoder'],
    ['Codex: fix parser | OC | Claude Code', 'codex'],
    ['⠂ 🐋 Codex: fix parser', 'dsh'],
    ['⠂ 🐋 Codex | Claude Code', 'dsh'],
    ['🐋 Claude Code', 'dsh'],
    ['GitHub Copilot', 'copilot'],
    ['copilot.exe - action required', 'copilot'],
    ['devin thinking', 'devin'],
    ['aider.ps1 ready', 'aider'],
    ['⠋ - Waiting for response… - grok', 'grok'],
    ['grok done', 'grok'],
    ['Jcode', 'jcode'],
    ['Antigravity', 'antigravity'],
    ['agy — Gemini 3.1 Pro', 'antigravity'],
    ['OC | Compare Codex and Claude', 'opencode'],
    ['ssh host | opencode ready', 'opencode'],
    ['opencode2', 'opencode2'],
    ['MiMo Code', 'mimo-code'],
    ['Cursor Agent', 'cursor'],
    ['⠋ Droid', 'droid'],
    ['droid.exe', 'droid'],
    ['tmux | claude - action required', 'claude'],
    ['hermes ready', 'hermes'],
    ['DeepSeek Build', 'dsb'],
    ['🐋 DeepSeek Harness', 'dsh'],
    ['π > session - ~/orca', 'pi'],
    ['OMP ready', 'omp'],
    ['Qoder CLI', 'qoder'],
    ['Qoder CLI CN', 'qoder-cn'],
    ['Qoder CLI CN (Codex | Claude Code)', 'qoder-cn'],
    ['Prime Agent', 'prime-agent'],
    ['Command Code', 'command-code'],
    ['⠋ ZCode', 'zcode'],
    ['ZCode ready', 'zcode'],
    ['Compare Antigravity with Gemini… - grok', 'grok'],
    ['Fix Codex terminal behavior… - grok', 'grok'],
    ['Codex parity fixes - grok', 'grok']
  ])('preserves the identity frame %j', (title, agent) => {
    expect(resolveExplicitTerminalTitleAgentType(title)).toBe(agent)
    expect(
      resolveTabAgentFromSignals({
        title,
        hookAgent: null,
        hasObservedAgentSignal: true,
        isRemote: true,
        launchAgent: agent === 'claude' ? 'codex' : 'claude'
      })
    ).toBe(agent)
  })

  it.each([
    'claude | zsh',
    'codex | main | fix the parser',
    '⠋ grok > next steps',
    'claude [banana]',
    'codex [working',
    '⠋ Fix foo | OC | bar',
    '✳ Fix foo | OC | bar',
    'OC | session - grok'
  ])('rejects wrapper prefixes, breadcrumbs and competing identities in %j', (title) => {
    expect(resolveExplicitTerminalTitleAgentType(title)).toBeNull()
  })

  it.each(['Continue', 'Goose', 'Charm', 'Amp', 'CodeBuddy'])(
    'keeps UI-only %s labels outside the producer grammar regardless of task nouns',
    (label) => {
      for (const title of [
        label,
        `⠋ ${label}`,
        `${label} ready`,
        `${label}: fix Codex`,
        `⠋ ${label}: fix Gemini`
      ]) {
        expect(resolveExplicitTerminalTitleAgentType(title), title).toBeNull()
      }
    }
  )

  it.each([
    '✳ Codex',
    '. Codex',
    '* Codex',
    '✳ agy',
    '. Codex: fix parser',
    '✳ Codex | Claude Code'
  ])('does not turn generic Claude activity into foreign identity: %s', (title) =>
    expect(resolveExplicitTerminalTitleAgentType(title)).toBeNull()
  )

  it('separates identity from exact legacy policy, including the generic Claude exclusion', () => {
    for (const [title, policy] of [
      ['Fix the codex launcher', 'codex'],
      ['⠋ fix the grok launcher', 'grok'],
      ['⠋ fix the parser', null],
      ['task ⠋', null],
      ['✳', null],
      ['. Review the parser', null],
      ['* Review the parser', null]
    ] as const) {
      expect(resolveExplicitTerminalTitleAgentType(title), title).toBeNull()
      expect(resolveTerminalTitlePolicyAgentType(title), title).toBe(policy)
    }
    expect(resolveTerminalTitlePolicyAgentType('claude ~/p/repo')).toBe('claude')
    expect(resolveTerminalTitlePolicyAgentType('✳ Claude Code')).toBe('claude')
  })
})
