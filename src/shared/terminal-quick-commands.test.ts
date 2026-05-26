import { describe, expect, it } from 'vitest'
import {
  buildTerminalQuickCommandInput,
  getDefaultTerminalQuickCommands,
  normalizeTerminalQuickCommands,
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
        command: 'git status',
        appendEnter: false,
        scope: { type: 'global' }
      },
      {
        id: 'empty-command',
        label: 'Empty',
        command: '',
        appendEnter: true,
        scope: { type: 'global' }
      },
      {
        id: 'status-2',
        label: 'Duplicate',
        command: 'pwd',
        appendEnter: true,
        scope: { type: 'global' }
      },
      {
        id: 'quick-command-4',
        label: 'No ID',
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
        command: 'pnpm dev',
        appendEnter: true,
        scope: { type: 'repo', repoId: 'repo-1' }
      },
      {
        id: 'bad-repo',
        label: 'Bad',
        command: 'echo bad',
        appendEnter: true,
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
})
