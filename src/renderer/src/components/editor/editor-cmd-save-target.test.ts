import { describe, expect, it, vi } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import type { Tab } from '../../../../shared/types'
import { getEditorCmdSaveFileId } from './editor-cmd-save-target'

function makeTab(contentType: Tab['contentType'], entityId: string): Tab {
  return {
    id: `tab-${entityId}`,
    entityId,
    contentType,
    label: entityId,
    groupId: 'group-1',
    worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

describe('getEditorCmdSaveFileId', () => {
  it('targets the main active editor when the floating panel does not own the event', () => {
    const getActiveTab = vi.fn(() => makeTab('editor', 'floating-file'))

    expect(
      getEditorCmdSaveFileId(
        {
          activeFileId: 'main-file',
          activeTabType: 'editor',
          activeView: 'terminal',
          getActiveTab
        },
        false
      )
    ).toBe('main-file')
    expect(getActiveTab).not.toHaveBeenCalled()
  })

  it('claims nothing on a non-workspace view so the shortcut is not swallowed', () => {
    const getActiveTab = vi.fn(() => null)

    for (const activeView of ['tasks', 'settings', 'activity'] as const) {
      expect(
        getEditorCmdSaveFileId(
          { activeFileId: 'main-file', activeTabType: 'editor', activeView, getActiveTab },
          false
        )
      ).toBeNull()
    }
  })

  it('targets only an active floating editor and never falls through to main', () => {
    const getActiveTab = vi
      .fn<(worktreeId: string) => Tab | null>()
      .mockReturnValueOnce(makeTab('editor', 'floating-file'))
      .mockReturnValueOnce(makeTab('browser', 'floating-browser'))
    const state = {
      activeFileId: 'main-file',
      activeTabType: 'editor',
      activeView: 'terminal' as const,
      getActiveTab
    }

    expect(getEditorCmdSaveFileId(state, true)).toBe('floating-file')
    expect(getEditorCmdSaveFileId(state, true)).toBeNull()
    expect(getActiveTab).toHaveBeenNthCalledWith(1, FLOATING_TERMINAL_WORKTREE_ID)
    expect(getActiveTab).toHaveBeenNthCalledWith(2, FLOATING_TERMINAL_WORKTREE_ID)
  })

  it('still targets the floating editor from a non-workspace view', () => {
    const getActiveTab = vi.fn(() => makeTab('editor', 'floating-file'))

    expect(
      getEditorCmdSaveFileId(
        { activeFileId: 'main-file', activeTabType: 'editor', activeView: 'tasks', getActiveTab },
        true
      )
    ).toBe('floating-file')
  })
})
