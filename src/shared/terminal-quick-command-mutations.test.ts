import { describe, expect, it } from 'vitest'
import {
  buildTerminalQuickCommandCreate,
  buildTerminalQuickCommandUpdate,
  filterTerminalQuickCommandsByScope
} from './terminal-quick-command-mutations'
import {
  MAX_QUICK_COMMAND_AGENT_PROMPT_LENGTH,
  MAX_QUICK_COMMAND_ID_LENGTH,
  MAX_QUICK_COMMAND_LABEL_LENGTH,
  MAX_QUICK_COMMAND_TERMINAL_TEXT_LENGTH
} from './terminal-quick-commands'
import type { TerminalQuickCommand } from './terminal-quick-command-types'

const nextId = (value: string) => () => value

function shellCommand(overrides: Partial<TerminalQuickCommand> = {}): TerminalQuickCommand {
  return {
    id: 'qc-1',
    label: 'Run tests',
    scope: { type: 'global' },
    action: 'terminal-command',
    command: 'pnpm test',
    appendEnter: true,
    ...overrides
  } as TerminalQuickCommand
}

describe('buildTerminalQuickCommandCreate', () => {
  it('creates a repo-scoped shell command with a generated id', () => {
    expect(
      buildTerminalQuickCommandCreate(
        { label: 'Build', command: 'pnpm build', scope: { type: 'repo', repoId: 'repo-1' } },
        nextId('qc-new')
      )
    ).toMatchObject({
      id: 'qc-new',
      label: 'Build',
      command: 'pnpm build',
      appendEnter: true,
      scope: { type: 'repo', repoId: 'repo-1' }
    })
  })

  it('honours appendEnter false', () => {
    expect(
      buildTerminalQuickCommandCreate(
        { label: 'Draft', command: 'rm -rf build', appendEnter: false },
        nextId('qc-new')
      )
    ).toMatchObject({ appendEnter: false })
  })

  it('creates an agent-prompt command', () => {
    expect(
      buildTerminalQuickCommandCreate(
        { label: 'Review', action: 'agent-prompt', agent: 'claude', prompt: 'review the diff' },
        nextId('qc-agent')
      )
    ).toMatchObject({ action: 'agent-prompt', agent: 'claude', prompt: 'review the diff' })
  })

  it('separates a missing agent from an unsupported one', () => {
    expect(() =>
      buildTerminalQuickCommandCreate(
        { label: 'Review', action: 'agent-prompt', prompt: 'hi' },
        nextId('qc-agent')
      )
    ).toThrow('quick_command_agent_required')
    expect(() =>
      buildTerminalQuickCommandCreate(
        { label: 'Review', action: 'agent-prompt', agent: 'not-an-agent', prompt: 'hi' },
        nextId('qc-agent')
      )
    ).toThrow('quick_command_agent_unsupported')
  })

  it('rejects an empty body and an empty label', () => {
    expect(() =>
      buildTerminalQuickCommandCreate({ label: 'Empty', command: '   ' }, nextId('qc-new'))
    ).toThrow('quick_command_body_required')
    expect(() =>
      buildTerminalQuickCommandCreate({ label: '  ', command: 'ls' }, nextId('qc-new'))
    ).toThrow('quick_command_label_required')
  })

  it('rejects a prompt or agent on a shell command', () => {
    expect(() =>
      buildTerminalQuickCommandCreate({ label: 'Review', prompt: 'hi' }, nextId('qc-new'))
    ).toThrow('quick_command_body_action_mismatch')
    expect(() =>
      buildTerminalQuickCommandCreate(
        { label: 'Review', action: 'terminal-command', command: 'ls', agent: 'claude' },
        nextId('qc-new')
      )
    ).toThrow('quick_command_body_action_mismatch')
  })

  it('rejects a command or appendEnter on an agent prompt', () => {
    expect(() =>
      buildTerminalQuickCommandCreate(
        { label: 'Review', agent: 'claude', prompt: 'hi', command: 'ls' },
        nextId('qc-new')
      )
    ).toThrow('quick_command_body_action_mismatch')
    expect(() =>
      buildTerminalQuickCommandCreate(
        { label: 'Review', agent: 'claude', prompt: 'hi', appendEnter: false },
        nextId('qc-new')
      )
    ).toThrow('quick_command_body_action_mismatch')
  })

  it('rejects input past the stored caps instead of letting it be truncated', () => {
    expect(() =>
      buildTerminalQuickCommandCreate(
        { label: 'Long', command: 'x'.repeat(MAX_QUICK_COMMAND_TERMINAL_TEXT_LENGTH + 1) },
        nextId('qc-new')
      )
    ).toThrow('quick_command_body_too_long')
    expect(() =>
      buildTerminalQuickCommandCreate(
        {
          label: 'Long',
          agent: 'claude',
          prompt: 'x'.repeat(MAX_QUICK_COMMAND_AGENT_PROMPT_LENGTH + 1)
        },
        nextId('qc-new')
      )
    ).toThrow('quick_command_body_too_long')
    expect(() =>
      buildTerminalQuickCommandCreate(
        { label: 'L'.repeat(MAX_QUICK_COMMAND_LABEL_LENGTH + 1), command: 'ls' },
        nextId('qc-new')
      )
    ).toThrow('quick_command_label_too_long')
    expect(() =>
      buildTerminalQuickCommandCreate(
        { id: 'i'.repeat(MAX_QUICK_COMMAND_ID_LENGTH + 1), label: 'Long id', command: 'ls' },
        nextId('qc-new')
      )
    ).toThrow('quick_command_id_too_long')
  })

  it('accepts a body exactly at the cap', () => {
    expect(
      buildTerminalQuickCommandCreate(
        { label: 'At cap', command: 'x'.repeat(MAX_QUICK_COMMAND_TERMINAL_TEXT_LENGTH) },
        nextId('qc-new')
      )
    ).toMatchObject({ command: 'x'.repeat(MAX_QUICK_COMMAND_TERMINAL_TEXT_LENGTH) })
  })
})

describe('buildTerminalQuickCommandUpdate', () => {
  it('renames without touching the body', () => {
    expect(buildTerminalQuickCommandUpdate(shellCommand(), { label: 'Renamed' })).toMatchObject({
      label: 'Renamed',
      command: 'pnpm test',
      appendEnter: true
    })
  })

  it('carries the body across an action switch in both directions', () => {
    const toAgent = buildTerminalQuickCommandUpdate(shellCommand(), {
      action: 'agent-prompt',
      agent: 'claude'
    })
    expect(toAgent).toMatchObject({ action: 'agent-prompt', agent: 'claude', prompt: 'pnpm test' })

    expect(buildTerminalQuickCommandUpdate(toAgent, { action: 'terminal-command' })).toMatchObject({
      action: 'terminal-command',
      command: 'pnpm test',
      appendEnter: true
    })
  })

  it('rejects a prompt aimed at a shell command instead of ignoring it', () => {
    expect(() =>
      buildTerminalQuickCommandUpdate(shellCommand(), { prompt: 'review the diff' })
    ).toThrow('quick_command_body_action_mismatch')
  })

  it('rejects appendEnter aimed at an agent prompt instead of ignoring it', () => {
    const agentCommand = buildTerminalQuickCommandUpdate(shellCommand(), {
      action: 'agent-prompt',
      agent: 'claude'
    })
    expect(() => buildTerminalQuickCommandUpdate(agentCommand, { appendEnter: false })).toThrow(
      'quick_command_body_action_mismatch'
    )
  })

  it('rejects a command that would be stored truncated', () => {
    expect(() =>
      buildTerminalQuickCommandUpdate(shellCommand(), {
        command: 'x'.repeat(MAX_QUICK_COMMAND_TERMINAL_TEXT_LENGTH + 1)
      })
    ).toThrow('quick_command_body_too_long')
  })

  it('moves scope only when asked', () => {
    expect(
      buildTerminalQuickCommandUpdate(shellCommand({ scope: { type: 'repo', repoId: 'repo-1' } }), {
        label: 'Renamed'
      })
    ).toMatchObject({ scope: { type: 'repo', repoId: 'repo-1' } })
    expect(
      buildTerminalQuickCommandUpdate(shellCommand({ scope: { type: 'repo', repoId: 'repo-1' } }), {
        scope: { type: 'global' }
      })
    ).toMatchObject({ scope: { type: 'global' } })
  })
})

describe('filterTerminalQuickCommandsByScope', () => {
  const commands = [
    shellCommand({ id: 'qc-global' }),
    shellCommand({ id: 'qc-repo-1', scope: { type: 'repo', repoId: 'repo-1' } }),
    shellCommand({ id: 'qc-repo-2', scope: { type: 'repo', repoId: 'repo-2' } })
  ]

  it('keeps only global commands', () => {
    expect(filterTerminalQuickCommandsByScope(commands, { type: 'global' }).map((c) => c.id)).toEqual(
      ['qc-global']
    )
  })

  it('keeps only the matching repo commands', () => {
    expect(
      filterTerminalQuickCommandsByScope(commands, { type: 'repo', repoId: 'repo-1' }).map(
        (c) => c.id
      )
    ).toEqual(['qc-repo-1'])
  })
})
