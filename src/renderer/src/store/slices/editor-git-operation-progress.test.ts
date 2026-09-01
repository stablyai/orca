import { describe, expect, it, vi } from 'vitest'
import { createEditorStore } from './editor-slice-test-harness'

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
vi.mock('@/runtime/close-mirrored-editor-tab', () => ({
  notifyHostOfMirroredEditorClose: vi.fn()
}))

const progress = {
  headName: 'triage-e2e',
  onto: 'origin/main',
  currentStep: 3,
  totalSteps: 7,
  commitSubject: 'ci: split the e2e shards',
  stoppedBy: 'pick' as const
}

describe('git operation progress in the editor store', () => {
  it('publishes the progress a host reported with a rebase', () => {
    const store = createEditorStore()

    store.getState().setGitStatus('wt-1', {
      conflictOperation: 'rebase',
      entries: [],
      operationProgress: progress
    })

    expect(store.getState().gitOperationProgressByWorktree['wt-1']).toEqual(progress)
  })

  // Wire compatibility: a host that predates the field omits it. Absent means unknown,
  // and the renderer must see undefined rather than a zeroed placeholder.
  it('records nothing at all when the host omitted the field', () => {
    const store = createEditorStore()

    store.getState().setGitStatus('wt-old-host', {
      conflictOperation: 'rebase',
      entries: []
    })

    expect(store.getState().gitOperationProgressByWorktree).not.toHaveProperty('wt-old-host')
    expect(store.getState().gitOperationProgressByWorktree['wt-old-host']).toBeUndefined()
    // The operation itself still lands, so the banner degrades rather than disappearing.
    expect(store.getState().gitConflictOperationByWorktree['wt-old-host']).toBe('rebase')
  })

  it('advances the step as the rebase moves on', () => {
    const store = createEditorStore()
    store.getState().setGitStatus('wt-1', {
      conflictOperation: 'rebase',
      entries: [],
      operationProgress: progress
    })

    store.getState().setGitStatus('wt-1', {
      conflictOperation: 'rebase',
      entries: [],
      operationProgress: { ...progress, currentStep: 4 }
    })

    expect(store.getState().gitOperationProgressByWorktree['wt-1']?.currentStep).toBe(4)
  })

  it('drops the progress once the operation ends', () => {
    const store = createEditorStore()
    store.getState().setGitStatus('wt-1', {
      conflictOperation: 'rebase',
      entries: [],
      operationProgress: progress
    })

    store.getState().setGitStatus('wt-1', { conflictOperation: 'unknown', entries: [] })

    expect(store.getState().gitOperationProgressByWorktree).not.toHaveProperty('wt-1')
  })

  it('drops the progress when a non-active worktree clears its operation', () => {
    const store = createEditorStore()
    store.getState().setGitStatus('wt-2', {
      conflictOperation: 'rebase',
      entries: [],
      operationProgress: progress
    })

    store.getState().setConflictOperation('wt-2', 'unknown')

    expect(store.getState().gitOperationProgressByWorktree).not.toHaveProperty('wt-2')
  })

  // A capped snapshot never reads the rebase state dir, so its silence is not evidence.
  it('keeps the last known progress across a capped status snapshot', () => {
    const store = createEditorStore()
    store.getState().setGitStatus('wt-huge', {
      conflictOperation: 'rebase',
      entries: [],
      operationProgress: progress
    })

    store.getState().setGitStatus('wt-huge', {
      conflictOperation: 'rebase',
      entries: [{ path: 'a.ts', status: 'untracked', area: 'untracked' }],
      didHitLimit: true,
      statusLength: 2
    })

    expect(store.getState().gitOperationProgressByWorktree['wt-huge']).toEqual(progress)
  })
})
