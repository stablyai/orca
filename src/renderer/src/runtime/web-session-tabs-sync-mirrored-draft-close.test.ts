// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tab } from '../../../shared/tab-types'
import type { OpenFile } from '../store/slices/editor'

const closeWebRuntimeSessionTabMock = vi.fn(async (_args: unknown) => 'applied' as const)

vi.mock('./web-runtime-session', () => ({
  closeWebRuntimeSessionTab: (args: unknown) => closeWebRuntimeSessionTabMock(args)
}))

import { useAppStore } from '../store'
import { createWorkspaceTabCloseCommands } from '@/components/tab-group/workspace-tab-close-commands'
import { ORCA_EDITOR_REQUEST_FILE_CLOSE_EVENT } from '@/components/editor/editor-autosave'
import { applyWebSessionTabsSnapshot } from './web-session-tabs-sync'
import {
  ENV,
  NOW,
  WT,
  makeSnapshot,
  resetWebSessionTabsSyncTestState
} from './web-session-tabs-sync-test-harness'

const notesPath = '/repo/NOTES.md'
const clientDraft = '# unsaved client edits'

const notesUnifiedTab: Tab = {
  id: 'host-notes-unified',
  entityId: notesPath,
  groupId: 'host-group-1',
  worktreeId: WT,
  contentType: 'editor',
  label: 'NOTES.md',
  customLabel: null,
  color: null,
  sortOrder: 0,
  createdAt: NOW - 10,
  isPreview: false,
  isPinned: false
}

// A host-mirrored tab the user has edited on this client: dirty, with a draft recorded.
const clientDirtyMirroredNotes: OpenFile = {
  id: notesPath,
  filePath: notesPath,
  relativePath: 'NOTES.md',
  worktreeId: WT,
  language: 'markdown',
  isDirty: true,
  runtimeEnvironmentId: ENV,
  mode: 'edit',
  mirroredFromRuntimeSession: true
}

// The host republishes the same tab; its own store has no unsaved edits.
function hostCleanRepublish() {
  return makeSnapshot(
    [
      {
        type: 'markdown',
        id: notesUnifiedTab.id,
        title: 'NOTES.md',
        filePath: notesPath,
        relativePath: 'NOTES.md',
        language: 'markdown',
        mode: 'edit',
        isDirty: false,
        isActive: true,
        sourceFileId: notesPath,
        sourceFilePath: notesPath,
        sourceRelativePath: 'NOTES.md',
        documentVersion: `file:${notesPath}`,
        color: null,
        isPinned: false
      }
    ],
    { activeTabId: notesUnifiedTab.id, activeTabType: 'markdown' }
  )
}

describe('tab-strip close of a client-dirty mirrored file after a host republish (#21392)', () => {
  const initialState = useAppStore.getState()
  const closeRequests: string[] = []
  const onCloseRequest = (event: Event): void => {
    if (event instanceof CustomEvent) {
      closeRequests.push(String(event.detail?.fileId))
    }
  }

  beforeEach(() => {
    resetWebSessionTabsSyncTestState()
    closeWebRuntimeSessionTabMock.mockClear()
    closeRequests.length = 0
    window.addEventListener(ORCA_EDITOR_REQUEST_FILE_CLOSE_EVENT, onCloseRequest)
    useAppStore.setState({
      ...initialState,
      activeWorktreeId: WT,
      openFiles: [clientDirtyMirroredNotes],
      editorDrafts: { [notesPath]: clientDraft },
      unifiedTabsByWorktree: { [WT]: [notesUnifiedTab] }
    })
  })

  afterEach(() => {
    window.removeEventListener(ORCA_EDITOR_REQUEST_FILE_CLOSE_EVENT, onCloseRequest)
    useAppStore.setState(initialState, true)
  })

  it('routes the close to the unsaved-changes prompt instead of discarding the draft', () => {
    // Why: this is the user-visible property. #21363 lost a draft on a transient error; this
    // path loses one on an ordinary Cmd+W / tab X unless the client's dirty flag survives the
    // host's republish, because the tab strip gates its prompt on that flag alone.
    const patch = applyWebSessionTabsSnapshot(
      useAppStore.getState(),
      hostCleanRepublish(),
      ENV,
      NOW
    )
    useAppStore.setState(patch)

    createWorkspaceTabCloseCommands({ worktreeId: WT, groupTabs: [notesUnifiedTab] }).closeItem(
      notesUnifiedTab.id
    )

    // Prompted, not closed: the request went to the save/discard queue and nothing was lost.
    expect(closeRequests).toEqual([notesPath])
    const state = useAppStore.getState()
    expect(state.openFiles.some((file) => file.id === notesPath)).toBe(true)
    expect(state.editorDrafts[notesPath]).toBe(clientDraft)
    expect(closeWebRuntimeSessionTabMock).not.toHaveBeenCalled()
  })
})
