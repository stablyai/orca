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

  it('replaces stale Codex spinner titles when hook state finishes', () => {
    expect(
      resolveAgentStatusTerminalTitle({ agentType: 'codex', state: 'done' }, '\u280b Codex')
    ).toBe('Codex ready')
  })

  it('uses permission titles for Codex when hook state waits on user input', () => {
    expect(
      resolveAgentStatusTerminalTitle({ agentType: 'codex', state: 'waiting' }, '\u280b Codex')
    ).toBe('Codex - action required')
  })

  it('uses Devin synthetic titles for hook status transitions', () => {
    expect(
      resolveAgentStatusTerminalTitle({ agentType: 'devin', state: 'done' }, '\u280b Devin')
    ).toBe('Devin ready')
    expect(
      resolveAgentStatusTerminalTitle({ agentType: 'devin', state: 'waiting' }, '\u280b Devin')
    ).toBe('Devin - action required')
  })
})
