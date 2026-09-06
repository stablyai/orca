import { describe, expect, it } from 'vitest'
import { isGeminiTerminalTitle } from './agent-title-core'
import { getAgentLabel, isClaudeAgent } from './agent-title-identity'
import { detectAgentStatusFromTitle } from './agent-title-status'
import { TERMINAL_TITLE_CLASSIFICATION_CORPUS } from './terminal-title-classification-corpus'
import {
  getAgentLabel as getExplicitAgentLabel,
  isClaudeAgent as isExplicitClaudeAgent,
  resolveExplicitTerminalTitleAgentType,
  resolveTerminalTitleAgentType
} from './terminal-title-agent-type'

/**
 * Pins the exact verdict every title classifier returns for a realistic corpus.
 *
 * Why: these classifiers are now memoized on the title string, and a caching bug
 * here would repaint a pane under the wrong agent. This table is the proof that
 * memoization is transparent — it was generated from the pre-memo implementation
 * and must keep matching byte-for-byte.
 */
type PinnedRow = [
  title: string,
  status: string | null,
  label: string | null,
  claude: boolean,
  gemini: boolean,
  explicitLabel: string | null,
  explicitClaude: boolean,
  titleAgent: string | null,
  explicitTitleAgent: string | null
]

const PINNED_CLASSIFICATIONS: readonly PinnedRow[] = [
  ['', null, null, false, false, null, false, null, null],
  ['zsh', null, null, false, false, null, false, null, null],
  ['bash', null, null, false, false, null, false, null, null],
  ['nwparker@mac: ~/orca', null, null, false, false, null, false, null, null],
  ['npm run dev', null, null, false, false, null, false, null, null],
  ['opencode-blinker', null, null, false, false, null, false, null, null],
  [
    'openclaude',
    'idle',
    'OpenClaude',
    false,
    false,
    'OpenClaude',
    false,
    'openclaude',
    'openclaude'
  ],
  ['openclaude-scratch', null, null, false, false, null, false, null, null],
  ['claude-scratch', null, null, false, false, null, false, null, null],
  ['~/codex/ready', null, null, false, false, null, false, null, null],
  ['review-14600-codex', null, null, false, false, null, false, null, null],
  ['timestamp ready', null, null, false, false, null, false, null, null],
  ['android build running', null, null, false, false, null, false, null, null],
  ['~/hermes/working', null, null, false, false, null, false, null, null],
  ['C:\\tools\\codex\\run', null, null, false, false, null, false, null, null],
  ['/usr/local/bin/claude/notes', null, null, false, false, null, false, null, null],
  ['agy-nightly', null, null, false, false, null, false, null, null],
  ['codex.exe', 'idle', 'Codex', false, false, 'Codex', false, 'codex', 'codex'],
  [
    'openclaude.cmd',
    'idle',
    'OpenClaude',
    false,
    false,
    'OpenClaude',
    false,
    'openclaude',
    'openclaude'
  ],
  [
    'claude.bat working',
    'working',
    'Claude Code',
    true,
    false,
    'Claude Code',
    true,
    'claude',
    'claude'
  ],
  ['aider.ps1 ready', 'idle', 'Aider', false, false, 'Aider', false, 'aider', 'aider'],
  [
    'copilot.exe - action required',
    'permission',
    'GitHub Copilot',
    false,
    false,
    'GitHub Copilot',
    false,
    'copilot',
    'copilot'
  ],
  ['droid.exe', null, null, false, false, null, false, null, null],
  ['\u2733', 'idle', 'Claude Code', true, false, 'Claude Code', true, 'claude', null],
  [
    '\u2733 Claude Code',
    'idle',
    'Claude Code',
    true,
    false,
    'Claude Code',
    true,
    'claude',
    'claude'
  ],
  ['\u2733 ready', 'idle', 'Claude Code', true, false, 'Claude Code', true, 'claude', null],
  ['. building the parser', null, 'Claude Code', true, false, 'Claude Code', true, 'claude', null],
  ['* done', null, 'Claude Code', true, false, 'Claude Code', true, 'claude', null],
  ['Claude Code', 'idle', 'Claude Code', true, false, 'Claude Code', true, 'claude', 'claude'],
  [
    'claude - action required',
    'permission',
    'Claude Code',
    true,
    false,
    'Claude Code',
    true,
    'claude',
    'claude'
  ],
  ['Claude ready', 'idle', 'Claude Code', true, false, 'Claude Code', true, 'claude', 'claude'],
  ['claude agents', null, null, false, false, null, false, null, null],
  ['"/usr/local/bin/claude" agents', null, null, false, false, null, false, null, null],
  [
    '\u280b Claude Code',
    'working',
    'Claude Code',
    true,
    false,
    'Claude Code',
    true,
    'claude',
    'claude'
  ],
  [
    '\u2809 Codex \u2014 refactoring',
    'working',
    'Codex',
    true,
    false,
    'Codex',
    true,
    'codex',
    'codex'
  ],
  ['\u25d0 working', 'working', 'Claude Code', true, false, 'Claude Code', true, 'claude', null],
  ['\u25d3 Grok', 'working', 'Grok', true, false, 'Grok', true, 'grok', 'grok'],
  ['\u280b Cursor Agent', 'working', 'Cursor', false, false, 'Cursor', false, 'cursor', 'cursor'],
  ['\u280b Droid', 'working', 'Droid', true, false, 'Droid', true, 'droid', 'droid'],
  ['\u280b Hermes', 'working', 'Hermes', true, false, 'Hermes', true, 'hermes', 'hermes'],
  ['\u2726 gemini', 'working', 'Gemini CLI', false, true, 'Gemini CLI', false, 'gemini', 'gemini'],
  [
    '\u23f2 Gemini CLI',
    'working',
    'Gemini CLI',
    false,
    true,
    'Gemini CLI',
    false,
    'gemini',
    'gemini'
  ],
  ['\u25c7 Gemini CLI', 'idle', 'Gemini CLI', false, true, 'Gemini CLI', false, 'gemini', 'gemini'],
  [
    '\u270b Gemini CLI',
    'permission',
    'Gemini CLI',
    false,
    true,
    'Gemini CLI',
    false,
    'gemini',
    'gemini'
  ],
  ['gemini', 'idle', 'Gemini CLI', false, true, 'Gemini CLI', false, 'gemini', 'gemini'],
  [
    'antigravity gemini 3 pro',
    'idle',
    'Antigravity',
    false,
    false,
    'Antigravity',
    false,
    'antigravity',
    'antigravity'
  ],
  [
    'agy - gemini 2 flash',
    'idle',
    'Antigravity',
    false,
    false,
    'Antigravity',
    false,
    'antigravity',
    'antigravity'
  ],
  ['codex working', 'working', 'Codex', false, false, 'Codex', false, 'codex', 'codex'],
  ['codex ready', 'idle', 'Codex', false, false, 'Codex', false, 'codex', 'codex'],
  [
    'copilot waiting',
    'permission',
    'GitHub Copilot',
    false,
    false,
    'GitHub Copilot',
    false,
    'copilot',
    'copilot'
  ],
  ['devin thinking', 'working', 'Devin', false, false, 'Devin', false, 'devin', 'devin'],
  ['mimo idle', 'idle', 'MiMo Code', false, false, 'MiMo Code', false, 'mimo-code', 'mimo-code'],
  ['aider running', 'working', 'Aider', false, false, 'Aider', false, 'aider', 'aider'],
  ['grok done', 'idle', 'Grok', false, false, 'Grok', false, 'grok', 'grok'],
  ['opencode ready', 'idle', 'OpenCode', false, false, 'OpenCode', false, 'opencode', 'opencode'],
  ['hermes ready', 'idle', 'Hermes', false, false, 'Hermes', false, 'hermes', 'hermes'],
  ['droid ready', 'idle', 'Droid', false, false, 'Droid', false, 'droid', 'droid'],
  ['cursor agent', null, 'Cursor', false, false, 'Cursor', false, 'cursor', 'cursor'],
  ['cursor ready', 'idle', 'Cursor', false, false, 'Cursor', false, 'cursor', 'cursor'],
  [
    'cursor - action required',
    'permission',
    'Cursor',
    false,
    false,
    'Cursor',
    false,
    'cursor',
    'cursor'
  ],
  ['cursor position reset', 'idle', null, false, false, null, false, null, null],
  ['\u03c0 > session - ~/orca', 'idle', 'Pi', false, false, 'Pi', false, 'pi', 'pi'],
  ['\u03c0 ! blocked-session', 'permission', 'Pi', false, false, 'Pi', false, 'pi', 'pi'],
  ['\u280b \u03c0 - session - ~/orca', 'working', 'Pi', true, false, 'Pi', true, 'pi', 'pi'],
  ['zsh | \u280b Codex', 'working', 'Codex', true, false, 'Codex', true, 'codex', 'codex'],
  ['tmux | claude - action required', 'permission', null, false, false, null, false, null, null],
  [
    'ssh host | opencode ready',
    'idle',
    'OpenCode',
    false,
    false,
    'OpenCode',
    false,
    'opencode',
    'opencode'
  ]
]

describe('terminal title classification', () => {
  it('covers every corpus title exactly once', () => {
    expect(PINNED_CLASSIFICATIONS.map(([title]) => title)).toEqual([
      ...TERMINAL_TITLE_CLASSIFICATION_CORPUS
    ])
  })

  it.each(PINNED_CLASSIFICATIONS)(
    'classifies %j identically',
    (
      title,
      status,
      label,
      claude,
      gemini,
      explicitLabel,
      explicitClaude,
      titleAgent,
      explicitTitleAgent
    ) => {
      expect(detectAgentStatusFromTitle(title)).toBe(status)
      expect(getAgentLabel(title)).toBe(label)
      expect(isClaudeAgent(title)).toBe(claude)
      expect(isGeminiTerminalTitle(title)).toBe(gemini)
      expect(getExplicitAgentLabel(title)).toBe(explicitLabel)
      expect(isExplicitClaudeAgent(title)).toBe(explicitClaude)
      expect(resolveTerminalTitleAgentType(title)).toBe(titleAgent)
      expect(resolveExplicitTerminalTitleAgentType(title)).toBe(explicitTitleAgent)
    }
  )

  it('returns the same verdict on the second read of every title', () => {
    for (const title of TERMINAL_TITLE_CLASSIFICATION_CORPUS) {
      expect(detectAgentStatusFromTitle(title)).toBe(detectAgentStatusFromTitle(title))
      expect(getAgentLabel(title)).toBe(getAgentLabel(title))
      expect(resolveExplicitTerminalTitleAgentType(title)).toBe(
        resolveExplicitTerminalTitleAgentType(title)
      )
    }
  })
})
