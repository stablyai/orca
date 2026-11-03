import { describe, expect, it } from 'vitest'
import { createFileExplorerDirLoadTracker } from './file-explorer-dir-load-tracker'

describe('createFileExplorerDirLoadTracker', () => {
  it('rejects stale completions for the same directory', () => {
    const tracker = createFileExplorerDirLoadTracker()

    const firstLoad = tracker.begin('/repo')
    const secondLoad = tracker.begin('/repo')

    expect(tracker.isCurrent(firstLoad)).toBe(false)
    expect(tracker.isCurrent(secondLoad)).toBe(true)
  })

  it('keeps concurrent loads for different directories independent', () => {
    const tracker = createFileExplorerDirLoadTracker()

    const rootLoad = tracker.begin('/repo')
    const childLoad = tracker.begin('/repo/src')

    expect(tracker.isCurrent(rootLoad)).toBe(true)
    expect(tracker.isCurrent(childLoad)).toBe(true)
  })

  it('invalidates pending loads when the tree reset session changes', () => {
    const tracker = createFileExplorerDirLoadTracker()
    const oldSessionLoad = tracker.begin('/repo')

    tracker.reset()
    const newSessionLoad = tracker.begin('/repo')

    expect(tracker.isCurrent(oldSessionLoad)).toBe(false)
    expect(tracker.isCurrent(newSessionLoad)).toBe(true)
  })

  it('invalidates session snapshots only when the tree reset session changes', () => {
    const tracker = createFileExplorerDirLoadTracker()

    const initialSession = tracker.getSession()
    tracker.begin('/repo')
    tracker.begin('/repo/src')

    expect(tracker.isSessionCurrent(initialSession)).toBe(true)

    tracker.reset()

    expect(tracker.isSessionCurrent(initialSession)).toBe(false)
    expect(tracker.isSessionCurrent(tracker.getSession())).toBe(true)
  })
})

it.each(['prepare', 'first-record', 'both'] as const)(
  'configured reset completes all records/session after %s failure',
  async (failureAt) => {
    const first = new Error('first failure'),
      second = new Error('record failure'),
      stages: string[] = []
    const tracker = createFileExplorerDirLoadTracker(() => {
      stages.push('prepare')
      if (failureAt !== 'first-record') {
        throw first
      }
    })
    const session = tracker.getSession()
    const a = tracker.begin('/repo/a', () => {
      stages.push('a')
      if (failureAt !== 'prepare') {
        throw second
      }
    })
    const b = tracker.begin('/repo/b', () => {
      stages.push('b')
    })
    const outcomes: string[] = []
    void a.promise.then((outcome) => outcomes.push(outcome))
    void b.promise.then((outcome) => outcomes.push(outcome))
    expect(() => tracker.reset()).toThrow(failureAt === 'first-record' ? second : first)
    expect(stages).toEqual(['prepare', 'a', 'b'])
    expect(tracker.isSessionCurrent(session)).toBe(false)
    await Promise.resolve()
    expect(outcomes).toEqual(['superseded', 'superseded'])
    expect(tracker.get('/repo/a')).toBeUndefined()
    expect(tracker.get('/repo/b')).toBeUndefined()
    const successor = tracker.begin('/repo/a')
    tracker.finish(a, 'refreshed')
    expect(tracker.isCurrent(successor)).toBe(true)
    tracker.finish(successor, 'refreshed')
    expect(await successor.promise).toBe('refreshed')
  }
)
