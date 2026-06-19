import { describe, expect, it } from 'vitest'
import { detectPiAgentKindFromCommand } from './pi-agent-kind'

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

  it('returns "omp" for omp launched via an absolute path', () => {
    expect(detectPiAgentKindFromCommand('/usr/local/bin/omp')).toBe('omp')
    expect(detectPiAgentKindFromCommand('~/bin/omp.sh')).toBe('omp')
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
