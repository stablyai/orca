import { describe, expect, it } from 'vitest'
import {
  buildTerminalQuickCommandInput,
  flattenTerminalQuickCommand,
  getTerminalQuickCommandAction,
  getTerminalQuickCommandBody,
  getDefaultTerminalQuickCommands,
  isTerminalQuickCommandComplete,
  normalizeTerminalQuickCommands,
  supportsTerminalAgentQuickCommand,
  terminalQuickCommandMatchesRepo
} from './terminal-quick-commands'

describe('terminal quick commands', () => {
  it('returns safe defaults when persisted settings are missing', () => {
    expect(normalizeTerminalQuickCommands(undefined)).toEqual([])
    expect(getDefaultTerminalQuickCommands()).toEqual([])
  })

  it('keeps an intentionally empty command list', () => {
    expect(normalizeTerminalQuickCommands([])).toEqual([])
  })

  it('removes quick commands from the abandoned preset rollout', () => {
    expect(
      normalizeTerminalQuickCommands([
        {
          id: 'default-pwd',
          label: 'Print Working Directory',
          command: 'pwd',
          appendEnter: true
        },
        {
          id: 'default-git-status',
          label: 'Git Status',
          command: 'git status',
          appendEnter: true
        }
      ])
    ).toEqual([])
  })

  it('drops malformed entries and normalizes valid commands and drafts', () => {
    expect(
      normalizeTerminalQuickCommands([
        null,
        { id: 'status', label: '  Status  ', command: 'git status\n', appendEnter: false },
        { id: 'empty-command', label: 'Empty', command: '   ' },
        { id: 'status', label: 'Duplicate', command: 'pwd' },
        { label: 'No ID', command: 'date' }
      ])
    ).toEqual([
      {
        id: 'status',
        label: 'Status',
        action: 'terminal-command',
        command: 'git status',
        appendEnter: false,
        scope: { type: 'global' }
      },
      {
        id: 'empty-command',
        label: 'Empty',
        action: 'terminal-command',
        command: '',
        appendEnter: true,
        scope: { type: 'global' }
      },
      {
        id: 'status-2',
        label: 'Duplicate',
        action: 'terminal-command',
        command: 'pwd',
        appendEnter: true,
        scope: { type: 'global' }
      },
      {
        id: 'quick-command-4',
        label: 'No ID',
        action: 'terminal-command',
        command: 'date',
        appendEnter: true,
        scope: { type: 'global' }
      }
    ])
  })

  it('normalizes repository scoped commands and falls back to global for invalid scopes', () => {
    expect(
      normalizeTerminalQuickCommands([
        {
          id: 'repo-dev',
          label: 'Dev',
          command: 'pnpm dev',
          scope: { type: 'repo', repoId: ' repo-1 ' }
        },
        {
          id: 'bad-repo',
          label: 'Bad',
          command: 'echo bad',
          scope: { type: 'repo', repoId: '   ' }
        }
      ])
    ).toEqual([
      {
        id: 'repo-dev',
        label: 'Dev',
        action: 'terminal-command',
        command: 'pnpm dev',
        appendEnter: true,
        scope: { type: 'repo', repoId: 'repo-1' }
      },
      {
        id: 'bad-repo',
        label: 'Bad',
        action: 'terminal-command',
        command: 'echo bad',
        appendEnter: true,
        scope: { type: 'global' }
      }
    ])
  })

  it('normalizes agent prompt commands without storing generated shell text', () => {
    expect(
      normalizeTerminalQuickCommands([
        {
          id: 'agent-review',
          label: 'Review',
          action: 'agent-prompt',
          agent: 'codex',
          prompt: '  Review this diff\n',
          command: "codex 'old workaround'"
        },
        {
          id: 'unknown-agent',
          label: 'Unknown',
          action: 'agent-prompt',
          agent: 'not-real',
          prompt: 'Do work'
        },
        {
          id: 'post-start-agent',
          label: 'Aider',
          action: 'agent-prompt',
          agent: 'aider',
          prompt: 'Do work'
        }
      ])
    ).toEqual([
      {
        id: 'agent-review',
        label: 'Review',
        action: 'agent-prompt',
        agent: 'codex',
        prompt: '  Review this diff',
        scope: { type: 'global' }
      }
    ])
  })

  it('matches global commands everywhere and repo commands only in their repo', () => {
    expect(
      terminalQuickCommandMatchesRepo(
        {
          id: 'global',
          label: 'Global',
          command: 'date',
          appendEnter: true,
          scope: { type: 'global' }
        },
        null
      )
    ).toBe(true)
    expect(
      terminalQuickCommandMatchesRepo(
        {
          id: 'repo',
          label: 'Repo',
          command: 'pnpm dev',
          appendEnter: true,
          scope: { type: 'repo', repoId: 'repo-1' }
        },
        'repo-1'
      )
    ).toBe(true)
    expect(
      terminalQuickCommandMatchesRepo(
        {
          id: 'repo',
          label: 'Repo',
          command: 'pnpm dev',
          appendEnter: true,
          scope: { type: 'repo', repoId: 'repo-1' }
        },
        'repo-2'
      )
    ).toBe(false)
  })

  it('formats terminal input without assuming shell semantics', () => {
    expect(
      buildTerminalQuickCommandInput({
        id: 'status',
        label: 'Status',
        command: 'git status',
        appendEnter: true
      })
    ).toBe('git status\r')
    expect(
      buildTerminalQuickCommandInput({
        id: 'status',
        label: 'Status',
        command: 'git status',
        appendEnter: false
      })
    ).toBe('git status')
  })

  it('classifies quick command actions and body text', () => {
    const terminal = {
      id: 'status',
      label: 'Status',
      command: 'git status',
      appendEnter: true
    }
    const agent = {
      id: 'agent',
      label: 'Agent',
      action: 'agent-prompt' as const,
      agent: 'claude' as const,
      prompt: 'Fix the tests'
    }

    expect(getTerminalQuickCommandAction(terminal)).toBe('terminal-command')
    expect(getTerminalQuickCommandBody(terminal)).toBe('git status')
    expect(isTerminalQuickCommandComplete(terminal)).toBe(true)
    expect(getTerminalQuickCommandAction(agent)).toBe('agent-prompt')
    expect(getTerminalQuickCommandBody(agent)).toBe('Fix the tests')
    expect(isTerminalQuickCommandComplete(agent)).toBe(true)
  })

  it('only allows agent prompt quick commands for launch-time prompt agents', () => {
    expect(supportsTerminalAgentQuickCommand('claude')).toBe(true)
    expect(supportsTerminalAgentQuickCommand('gemini')).toBe(true)
    expect(supportsTerminalAgentQuickCommand('aider')).toBe(false)
    expect(supportsTerminalAgentQuickCommand('not-real')).toBe(false)
  })
})

describe('flattenTerminalQuickCommand', () => {
  it('returns the same object when there are no line breaks', () => {
    const command = {
      id: 'test',
      label: 'Test',
      command: 'git status',
      appendEnter: true
    } as const
    expect(flattenTerminalQuickCommand(command)).toBe(command)
  })

  it('replaces newlines with semicolons and spaces', () => {
    const result = flattenTerminalQuickCommand({
      id: 'test',
      label: 'Test',
      command: 'cd packages\nbun run build\ncd ..',
      appendEnter: true
    })
    expect(result.command).toBe('cd packages; bun run build; cd ..')
  })

  it('collapses consecutive newlines into a single separator', () => {
    const result = flattenTerminalQuickCommand({
      id: 'test',
      label: 'Test',
      command: 'echo one\n\n\necho two',
      appendEnter: true
    })
    expect(result.command).toBe('echo one; echo two')
  })

  it('handles Windows-style CRLF endings', () => {
    const result = flattenTerminalQuickCommand({
      id: 'test',
      label: 'Test',
      command: 'echo one\r\necho two',
      appendEnter: true
    })
    expect(result.command).toBe('echo one; echo two')
  })

  it('drops empty edge lines without leaving dangling separators', () => {
    const result = flattenTerminalQuickCommand({
      id: 'test',
      label: 'Test',
      command: '\n  echo one  \n\n  echo two\n',
      appendEnter: true
    })
    expect(result.command).toBe('echo one; echo two')
  })
})
