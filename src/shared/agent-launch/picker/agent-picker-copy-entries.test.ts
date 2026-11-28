import { describe, expect, it } from 'vitest'
import type { AgentCopy } from '../catalog/agent-copies'
import { withAgentPickerCopyEntries } from './agent-picker-copy-entries'
import { agentPickerEntryKey, type AgentPickerEntry } from './agent-launch-picker'

const claude: AgentPickerEntry = {
  agent: 'claude',
  label: 'Claude',
  rows: [{ kind: 'cli', agent: 'claude', executionHostId: 'local', chat: true }],
  surfaces: ['chat', 'terminal'],
  defaultSurface: 'terminal',
  terminal: {},
  structured: {},
  catalog: { origin: 'unknown' }
}
const codex: AgentPickerEntry = {
  ...claude,
  agent: 'codex',
  label: 'Codex',
  rows: [{ kind: 'cli', agent: 'codex', executionHostId: 'local' }],
  surfaces: ['terminal']
}
const codeMode: AgentCopy = {
  id: 'claude.claude-code-mode',
  name: 'Claude Code Mode',
  agent: 'claude',
  args: '',
  env: { CLAUDE_CODE_EXPERIMENTAL_CODE_MODE: '1' }
}

describe('withAgentPickerCopyEntries', () => {
  it('lists a copy right after its base agent, with the same surfaces and catalog', () => {
    const entries = withAgentPickerCopyEntries([claude, codex], [codeMode], ['claude', 'codex'], {
      agentDefaultSurface: 'terminal'
    })

    expect(entries.map(agentPickerEntryKey)).toEqual(['claude', 'claude.claude-code-mode', 'codex'])
    const copy = entries[1]!
    expect(copy).toMatchObject({
      agent: 'claude',
      label: 'Claude Code Mode',
      copy: { id: 'claude.claude-code-mode', name: 'Claude Code Mode' },
      surfaces: ['chat', 'terminal'],
      defaultSurface: 'terminal',
      catalog: claude.catalog
    })
    expect(copy.rows.every((row) => row.copy?.id === 'claude.claude-code-mode')).toBe(true)
  })

  it('leads with chat when the copy itself is set to Chat', () => {
    const [, copy] = withAgentPickerCopyEntries(
      [claude],
      [{ ...codeMode, chat: true }],
      ['claude'],
      {
        agentDefaultSurface: 'terminal'
      }
    )

    expect(copy?.defaultSurface).toBe('chat')
  })

  it('seeds the panel with the copy own model and arguments', () => {
    const [, copy] = withAgentPickerCopyEntries(
      [claude],
      [{ ...codeMode, args: '--verbose', choices: { model: 'haiku' } }],
      ['claude'],
      { agentDefaultArgs: { claude: '--base' } }
    )

    expect(copy?.arguments).toContain('--verbose')
    expect(copy?.arguments ?? '').not.toContain('--base')
    expect(copy?.terminal.model).toBe('haiku')
  })

  it('leaves out turned-off copies and copies of a base on another host', () => {
    const remote: AgentPickerEntry = {
      ...claude,
      rows: [{ kind: 'cli', agent: 'claude', executionHostId: 'ssh:box' }]
    }

    expect(
      withAgentPickerCopyEntries([claude], [{ ...codeMode, disabled: true }], ['claude'], {})
    ).toEqual([claude])
    expect(withAgentPickerCopyEntries([remote], [codeMode], ['claude'], {})).toEqual([remote])
  })
})
