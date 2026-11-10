import { beforeEach, describe, expect, it, vi } from 'vitest'

const activate = vi.hoisted(() => vi.fn())
const store: { state: Record<string, unknown> } = vi.hoisted(() => ({ state: {} }))
vi.mock('@/lib/workspace/activation/worktree-activation', () => ({
  activateAndRevealWorktree: activate
}))
vi.mock('@/store', () => ({ useAppStore: { getState: () => store.state } }))

import { planEditorShotCleanup, runEditorShotCleanup } from './plugin-view-editor-shot-cleanup'

let closeFile: ReturnType<typeof vi.fn>
let removeProject: ReturnType<typeof vi.fn>

beforeEach(() => {
  activate.mockReset()
  closeFile = vi.fn()
  removeProject = vi.fn(async () => undefined)
  store.state = {
    activeWorktreeId: 'shot-workspace',
    closeFile,
    removeProject,
    getKnownWorktreeById: (id: string) => (id === 'before' ? { id } : undefined)
  }
})

describe('after an editor shot', () => {
  it('closes a copy and removes its folder workspace, then shows the workspace from before', async () => {
    planEditorShotCleanup('shot', {
      fileId: 'copy',
      openedByShot: true,
      scratchRepoId: 'scratch-repo',
      previousWorktreeId: 'before'
    })
    await runEditorShotCleanup('shot')
    expect(closeFile).toHaveBeenCalledWith('copy')
    expect(removeProject).toHaveBeenCalledWith('scratch-repo', {
      hostId: 'local',
      errorFeedback: 'silent',
      automaticCleanup: true
    })
    expect(activate).toHaveBeenCalledWith('before', { providesInitialSurface: true })
    // Nothing is left to undo twice.
    await runEditorShotCleanup('shot')
    expect(closeFile).toHaveBeenCalledTimes(1)
  })

  it('closes the real file only when the shot opened it, and keeps its workspace', async () => {
    planEditorShotCleanup('shot', {
      fileId: 'real',
      openedByShot: false,
      scratchRepoId: null,
      previousWorktreeId: 'shot-workspace'
    })
    await runEditorShotCleanup('shot')
    expect(closeFile).not.toHaveBeenCalled()
    expect(removeProject).not.toHaveBeenCalled()
    expect(activate).not.toHaveBeenCalled()

    planEditorShotCleanup('shot', {
      fileId: 'real',
      openedByShot: true,
      scratchRepoId: null,
      previousWorktreeId: null
    })
    await runEditorShotCleanup('shot')
    expect(closeFile).toHaveBeenCalledWith('real')
    expect(removeProject).not.toHaveBeenCalled()
  })

  it('undoes only its own capture when shots overlap, and nothing without an id', async () => {
    const plan = (fileId: string) => ({
      fileId,
      openedByShot: true,
      scratchRepoId: null,
      previousWorktreeId: null
    })
    planEditorShotCleanup('a', plan('a-file'))
    planEditorShotCleanup('b', plan('b-file'))
    await runEditorShotCleanup(undefined)
    expect(closeFile).not.toHaveBeenCalled()
    await runEditorShotCleanup('a')
    expect(closeFile).toHaveBeenCalledWith('a-file')
    expect(closeFile).not.toHaveBeenCalledWith('b-file')
    await runEditorShotCleanup('b')
    expect(closeFile).toHaveBeenCalledWith('b-file')
  })
})
