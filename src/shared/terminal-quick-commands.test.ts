import { describe, expect, it } from 'vitest'
import {
  buildTerminalQuickCommandInput,
  getDefaultTerminalQuickCommands,
  normalizeTerminalQuickCommands
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
        appendEnter: false
      },
      {
        id: 'empty-command',
        label: 'Empty',
        command: '',
        appendEnter: true
      },
      {
        id: 'status-2',
        label: 'Duplicate',
        command: 'pwd',
        appendEnter: true
      },
      {
        id: 'quick-command-4',
        label: 'No ID',
        command: 'date',
        appendEnter: true
      }
    ])
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
