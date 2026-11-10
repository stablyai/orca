import { describe, expect, it } from 'vitest'
import { detectExplicitPiAgentKindFromCommand } from './pi-agent-kind'

describe('detectExplicitPiAgentKindFromCommand', () => {
  it('does not classify bare shells or other agents as Pi launches', () => {
    expect(detectExplicitPiAgentKindFromCommand(undefined)).toBeNull()
    expect(detectExplicitPiAgentKindFromCommand('')).toBeNull()
    expect(detectExplicitPiAgentKindFromCommand('codex --resume session-a')).toBeNull()
    expect(detectExplicitPiAgentKindFromCommand('codex "ask about pi"')).toBeNull()
    expect(detectExplicitPiAgentKindFromCommand('claude')).toBeNull()
    expect(detectExplicitPiAgentKindFromCommand('python3 script.py')).toBeNull()
  })

  it('classifies the launched agent instead of mentions in its arguments', () => {
    expect(detectExplicitPiAgentKindFromCommand('pi "compare omp"')).toBe('pi')
    expect(detectExplicitPiAgentKindFromCommand('omp "compare pi"')).toBe('omp')
    expect(detectExplicitPiAgentKindFromCommand('prime-agent "compare pi and omp"')).toBe(
      'prime-agent'
    )
  })
})

describe('detectExplicitPiAgentKindFromCommand after a sleep prefix', () => {
  it.each(['pi', 'omp', 'prime-agent'] as const)('prepares the %s integration', (agent) => {
    expect(detectExplicitPiAgentKindFromCommand(`sleep 30 && ${agent}`)).toBe(agent)
  })
})
