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
