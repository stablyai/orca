import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  __resetLocalWatchPauseStoreForTests,
  applyLocalWatchPausedPayload,
  forgetLocalWatchRoot,
  isLocalFileWatchPaused,
  noteLocalWatchRootHeld,
  setLocalWatchRequestFailed
} from './editor-watch-pause-store'

describe('local watch pause store', () => {
  beforeEach(() => noteLocalWatchRootHeld('/repo'))
  afterEach(() => __resetLocalWatchPauseStoreForTests())

  it('follows main pause pushes for the exact root', () => {
    applyLocalWatchPausedPayload({ worktreePath: '/repo', paused: true })
    expect(isLocalFileWatchPaused('/repo/docs/a.md')).toBe(true)
    // A file under a nested, separately watched healthy root is served by that root.
    noteLocalWatchRootHeld('/repo/packages/app')
    expect(isLocalFileWatchPaused('/repo/packages/app/readme.md')).toBe(false)
    // A sibling path that merely shares the prefix is not inside the root.
    expect(isLocalFileWatchPaused('/repository/a.md')).toBe(false)
    applyLocalWatchPausedPayload({ worktreePath: '/repo', paused: false })
    expect(isLocalFileWatchPaused('/repo/a.md')).toBe(false)
  })

  it('treats a rejected watch request as paused until a later request succeeds', () => {
    setLocalWatchRequestFailed('/repo', true)
    expect(isLocalFileWatchPaused('/repo/a.md')).toBe(true)
    setLocalWatchRequestFailed('/repo', false)
    expect(isLocalFileWatchPaused('/repo/a.md')).toBe(false)
  })

  it('forgets a root the renderer stopped holding', () => {
    applyLocalWatchPausedPayload({ worktreePath: '/repo', paused: true })
    setLocalWatchRequestFailed('/repo', true)
    forgetLocalWatchRoot('/repo')
    expect(isLocalFileWatchPaused('/repo/a.md')).toBe(false)
  })

  it('ignores a pause push for a root this renderer no longer holds', () => {
    forgetLocalWatchRoot('/repo')
    applyLocalWatchPausedPayload({ worktreePath: '/repo', paused: true })
    expect(isLocalFileWatchPaused('/repo/a.md')).toBe(false)
  })

  it('ignores a watch rejection that settles after the root was released', () => {
    forgetLocalWatchRoot('/repo')
    setLocalWatchRequestFailed('/repo', true)
    noteLocalWatchRootHeld('/repo')
    expect(isLocalFileWatchPaused('/repo/a.md')).toBe(false)
  })

  it('never reports a missing root as paused', () => {
    expect(isLocalFileWatchPaused(null)).toBe(false)
    expect(isLocalFileWatchPaused(undefined)).toBe(false)
  })
})
