import { describe, expect, it } from 'vitest'
import { resolveOuterWrapperForegroundProcess } from './foreground-wrapper-agent'

describe('resolveOuterWrapperForegroundProcess', () => {
  const omp = { agent: 'omp' as const, processName: 'omp' }
  const pi = { agent: 'pi' as const, processName: 'pi' }

  it('collapses a wrapped pi read onto the shallower omp wrapper', () => {
    // Winner is the deeper pi (depth 2); omp is its wrapper at depth 1.
    expect(
      resolveOuterWrapperForegroundProcess(pi, { pid: 102, ppid: 101, command: 'pi' }, [
        { pid: 102, ppid: 101, command: 'pi' },
        { pid: 101, ppid: 100, command: 'omp' }
      ])
    ).toBe('omp')
  })

  it('keeps bare pi when no same-group wrapper is present', () => {
    const barePi = { pid: 101, ppid: 100, command: 'pi' }
    expect(resolveOuterWrapperForegroundProcess(pi, barePi, [barePi])).toBe('pi')
  })

  it('leaves a cross-group agent (codex) untouched even under a deeper same-name child', () => {
    const codex = { agent: 'codex' as const, processName: 'codex' }
    expect(
      resolveOuterWrapperForegroundProcess(
        codex,
        { pid: 102, ppid: 101, command: 'node /usr/bin/codex' },
        [
          { pid: 102, ppid: 101, command: 'node /usr/bin/codex' },
          { pid: 101, ppid: 100, command: 'bash -l' }
        ]
      )
    ).toBe('codex')
  })

  it('does not promote a deeper pi over an already-outer omp winner', () => {
    expect(
      resolveOuterWrapperForegroundProcess(omp, { pid: 101, ppid: 100, command: 'omp' }, [
        { pid: 101, ppid: 100, command: 'omp' },
        { pid: 102, ppid: 101, command: 'pi' }
      ])
    ).toBe('omp')
  })

  it('does not treat an unrelated shallower omp sibling as the pi wrapper', () => {
    expect(
      resolveOuterWrapperForegroundProcess(pi, { pid: 103, ppid: 102, command: 'pi' }, [
        { pid: 101, ppid: 100, command: 'omp' },
        { pid: 102, ppid: 100, command: 'node server.js' },
        { pid: 103, ppid: 102, command: 'pi' }
      ])
    ).toBe('pi')
  })
})
