import { describe, expect, it, vi } from 'vitest'

const openLinkedFileInEditorMock = vi.hoisted(() => vi.fn())

vi.mock('@/store', () => ({ useAppStore: { getState: () => ({}) } }))
vi.mock('@/lib/worktree-activation', () => ({ activateAndRevealWorkspace: vi.fn() }))
vi.mock('@/store/slices/editor/focus/editor-focus-reveal', () => ({
  cancelPendingEditorLineRevealFrames: vi.fn()
}))
vi.mock('./terminal-file-link-editor-open', () => ({
  openLinkedFileInEditor: openLinkedFileInEditorMock
}))

import { openFileInOwningWorkspace } from './terminal-file-other-workspace-hint'
import { reserveDetectedFilePathOpenTurn } from './terminal-file-open-turn'

describe('"Open there" from the other-workspace hint', () => {
  it('yields its line reveal to a later link click', () => {
    openFileInOwningWorkspace({
      fileId: 'view',
      filePath: '/b/report.md',
      owner: { worktreeId: 'wt-b', relativePath: 'report.md', executionHostId: 'local' },
      runtimeEnvironmentId: null,
      position: { line: 3, column: null }
    })
    const isCurrent: () => boolean = openLinkedFileInEditorMock.mock.calls[0][3]
    expect(isCurrent()).toBe(true)

    reserveDetectedFilePathOpenTurn()

    expect(isCurrent()).toBe(false)
  })
})
