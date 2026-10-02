import { describe, expect, it } from 'vitest'
import { detectExplicitPiAgentKindFromCommand, detectPiAgentKindFromCommand } from './pi-agent-kind'

describe('detectPiAgentKindFromCommand', () => {
  it('returns "pi" for undefined or empty commands', () => {
    expect(detectPiAgentKindFromCommand(undefined)).toBe('pi')
    expect(detectPiAgentKindFromCommand('')).toBe('pi')
  })

  it('returns "pi" for a bare pi launch', () => {
    expect(detectPiAgentKindFromCommand('pi')).toBe('pi')
    expect(detectPiAgentKindFromCommand('pi --resume')).toBe('pi')
  })

  it('returns "omp" for a bare omp launch', () => {
    expect(detectPiAgentKindFromCommand('omp')).toBe('omp')
    expect(detectPiAgentKindFromCommand('omp -v')).toBe('omp')
    expect(detectPiAgentKindFromCommand('omp.sh')).toBe('omp')
  })

  it('returns "prime-agent" for Prime launches', () => {
    expect(detectPiAgentKindFromCommand('prime-agent')).toBe('prime-agent')
    expect(detectPiAgentKindFromCommand('/usr/local/bin/prime-agent --resume session.jsonl')).toBe(
      'prime-agent'
    )
    expect(detectPiAgentKindFromCommand('PRIME-AGENT.EXE')).toBe('prime-agent')
    expect(detectPiAgentKindFromCommand('prime-agent.cmd')).toBe('prime-agent')
  })

  it('returns "omo" for OmO Native launches and not the senpi binary', () => {
    expect(detectPiAgentKindFromCommand('omo')).toBe('omo')
    expect(detectPiAgentKindFromCommand('omo --resume')).toBe('omo')
    expect(detectPiAgentKindFromCommand('/usr/local/bin/omo')).toBe('omo')
    expect(detectPiAgentKindFromCommand('OMO.EXE')).toBe('omo')
    // omo only — raw 'senpi' defaults to ~/.senpi/agent, a different home.
    expect(detectPiAgentKindFromCommand('senpi')).not.toBe('omo')
    expect(detectExplicitPiAgentKindFromCommand('senpi')).not.toBe('omo')
    expect(detectExplicitPiAgentKindFromCommand('senpi')).toBeNull()
  })

  it('returns "omp" for omp launched via an absolute path', () => {
    expect(detectPiAgentKindFromCommand('/usr/local/bin/omp')).toBe('omp')
    expect(detectPiAgentKindFromCommand('~/bin/omp.sh')).toBe('omp')
    expect(detectPiAgentKindFromCommand('"C:\\Program Files\\Orca\\omp.exe" --resume')).toBe('omp')
  })

  it('returns "pi" for pi launched via an absolute path', () => {
    expect(detectPiAgentKindFromCommand('/usr/local/bin/pi')).toBe('pi')
  })

  it('does not confuse "pi" with substrings like pip / mpi / python', () => {
    // Why: regression guard for the word-boundary regex. Without
    // boundary protection, any command containing the letters "pi"
    // would be classified as a Pi launch.
    expect(detectPiAgentKindFromCommand('pip install foo')).toBe('pi')
    expect(detectPiAgentKindFromCommand('mpirun -n 4 ./app')).toBe('pi')
    expect(detectPiAgentKindFromCommand('python3 script.py')).toBe('pi')
  })

  it('does not confuse "omp" with substrings like comp / pomp', () => {
    // Why: regression guard for the OMP boundary; falls back to 'pi'
    // when no match, which matches the pre-launch default.
    expect(detectPiAgentKindFromCommand('compile this')).toBe('pi')
    expect(detectPiAgentKindFromCommand('pomp.exe')).toBe('pi')
  })

  it('matches case-insensitively on Windows-style executables', () => {
    expect(detectPiAgentKindFromCommand('OMP.EXE')).toBe('omp')
    expect(detectPiAgentKindFromCommand('PI.CMD')).toBe('pi')
  })
})

describe('detectExplicitPiAgentKindFromCommand', () => {
  it('identifies explicit Pi, OMP, and Prime launches', () => {
    expect(detectExplicitPiAgentKindFromCommand('pi --resume')).toBe('pi')
    expect(detectExplicitPiAgentKindFromCommand('/usr/local/bin/omp.sh')).toBe('omp')
    expect(detectExplicitPiAgentKindFromCommand('PI.CMD')).toBe('pi')
    expect(detectExplicitPiAgentKindFromCommand('prime-agent.exe')).toBe('prime-agent')
    expect(detectExplicitPiAgentKindFromCommand('omo')).toBe('omo')
    expect(detectExplicitPiAgentKindFromCommand('omo --resume')).toBe('omo')
  })

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
    expect(detectExplicitPiAgentKindFromCommand('omo "compare omp"')).toBe('omo')
  })
})
