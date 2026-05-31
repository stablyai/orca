import { describe, expect, it } from 'vitest'
import { resolveAgentStatusTerminalTitle } from './agent-status-terminal-title'

describe('resolveAgentStatusTerminalTitle', () => {
  it('replaces stale Cursor spinner titles when hook state finishes', () => {
    expect(
      resolveAgentStatusTerminalTitle({ agentType: 'cursor', state: 'done' }, '\u2839 Cursor Agent')
    ).toBe('Cursor ready')
  })

  it('replaces bare Cursor native titles when hook state finishes', () => {
    expect(
      resolveAgentStatusTerminalTitle({ agentType: 'cursor', state: 'done' }, 'Cursor Agent')
    ).toBe('Cursor ready')
  })

  it('keeps descriptive completed titles that are already non-working', () => {
    expect(
      resolveAgentStatusTerminalTitle({ agentType: 'cursor', state: 'done' }, 'Orca Cursor Done')
    ).toBe('Orca Cursor Done')
  })

  it('uses permission titles for synthetic agents waiting on user input', () => {
    expect(
      resolveAgentStatusTerminalTitle(
        { agentType: 'cursor', state: 'waiting' },
        '\u280b Cursor Agent'
      )
    ).toBe('Cursor - action required')
  })

  it('clears stale permission titles when hook state finishes', () => {
    expect(
      resolveAgentStatusTerminalTitle(
        { agentType: 'cursor', state: 'done' },
        'Cursor - action required'
      )
    ).toBe('Cursor ready')
  })

  it('does not rewrite titles for agents without synthetic title profiles', () => {
    expect(
      resolveAgentStatusTerminalTitle({ agentType: 'codex', state: 'done' }, '\u280b Codex')
    ).toBe('\u280b Codex')
  })
})
