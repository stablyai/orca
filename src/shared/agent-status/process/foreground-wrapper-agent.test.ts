import { describe, expect, it } from 'vitest'
import {
  resolveOuterWrapperForegroundIdentity,
  resolveOuterWrapperForegroundProcess
} from './foreground-wrapper-agent'

describe('resolveOuterWrapperForegroundProcess', () => {
  const pi = { agent: 'pi' as const, processName: 'pi' }

  it('does not treat an unrelated shallower omp sibling as the pi wrapper', () => {
    expect(
      resolveOuterWrapperForegroundProcess(pi, { pid: 103, ppid: 102, command: 'pi' }, [
        { pid: 101, ppid: 100, command: 'omp' },
        { pid: 102, ppid: 100, command: 'node server.js' },
        { pid: 103, ppid: 102, command: 'pi' }
      ])
    ).toBe('pi')
  })

  it('carries the wrapper pid with a collapsed name, so liveness tracks the wrapper', () => {
    // Anchoring 'omp' to pi's pid would read a pi restart as omp's exit.
    expect(
      resolveOuterWrapperForegroundIdentity(pi, { pid: 102, ppid: 101, command: 'pi' }, [
        { pid: 102, ppid: 101, command: 'pi' },
        { pid: 101, ppid: 100, command: 'omp' }
      ])
    ).toEqual({ processName: 'omp', processId: 101 })
  })
})
