// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tab } from '../../../../../shared/workspace-layout/tab-groups/tab-types'
import type { OpenFile } from '../../../store/slices/editor/types/open-file'

const closeWebRuntimeSessionTabMock = vi.fn(async (_args: unknown) => 'applied' as const)

vi.mock('../actions/web-runtime-session-tab-lifecycle', () => ({
  closeWebRuntimeSessionTab: (args: unknown) => closeWebRuntimeSessionTabMock(args)
}))

import { useAppStore } from '../../../store/index'
import { createWorkspaceTabCloseCommands } from '@/lib/workspace/tabs/close/workspace-tab-close-commands'
import { attachEditorAutosaveController } from '@/components/editor/autosave/editor-autosave-controller'
import {
  ORCA_EDITOR_SAVE_AND_CLOSE_EVENT,
  type EditorSaveAndCloseDetail
} from '@/components/editor/autosave/editor-autosave'
import {
  ENV,
  NOW,
  WT,
  resetWebSessionTabsSyncTestState
} from '../testing/web-session-tabs-sync.test-fixture'

const readmePath = '/repo/README.md'

const readmeTab: Tab = {
  id: 'host-readme-tab',
  entityId: readmePath,
  groupId: 'host-group-1',
  worktreeId: WT,
  contentType: 'editor',
  label: 'README.md',
  customLabel: null,
  color: null,
  sortOrder: 0,
  createdAt: NOW - 10,
  isPreview: false,
  isPinned: false
}

const splitTab: Tab = { ...readmeTab, id: 'host-readme-split', groupId: 'host-group-2' }

function seed(tabs: Tab[], isDirty = false): void {
  const file: OpenFile = {
    id: readmePath,
    filePath: readmePath,
    relativePath: 'README.md',
    worktreeId: WT,
    language: 'markdown',
    isDirty,
    runtimeEnvironmentId: ENV,
    mode: 'edit',
    mirroredFromRuntimeSession: true
  }
  useAppStore.setState({
    activeWorktreeId: WT,
    openFiles: [file],
    unifiedTabsByWorktree: { [WT]: tabs }
  })
}

async function settledHostCloses(): Promise<unknown[]> {
  await new Promise((resolve) => setTimeout(resolve, 0))
  return closeWebRuntimeSessionTabMock.mock.calls.map(([args]) => args)
}

describe('closing a host-mirrored editor tab from the tab strip', () => {
  const initialState = useAppStore.getState()

  beforeEach(() => {
    resetWebSessionTabsSyncTestState()
    closeWebRuntimeSessionTabMock.mockClear()
  })

  afterEach(() => {
    useAppStore.setState(initialState, true)
  })

  it('closes the tab on its host once', async () => {
    seed([readmeTab])

    createWorkspaceTabCloseCommands({ worktreeId: WT, groupTabs: [readmeTab] }).closeItem(
      readmeTab.id
    )

    expect(useAppStore.getState().openFiles).toEqual([])
    expect(await settledHostCloses()).toEqual([
      { worktreeId: WT, tabId: readmeTab.id, environmentId: ENV, reason: 'user' }
    ])
  })

  it('closes only the closed split view on the host', async () => {
    seed([readmeTab, splitTab])

    useAppStore.getState().closeUnifiedTabs([splitTab.id])

    expect(useAppStore.getState().openFiles).toHaveLength(1)
    expect(await settledHostCloses()).toEqual([
      { worktreeId: WT, tabId: splitTab.id, environmentId: ENV, reason: 'user' }
    ])
  })

  it('closes a split view of a dirty file on the host', async () => {
    seed([readmeTab, splitTab], true)

    useAppStore.getState().closeUnifiedTabs([splitTab.id])

    expect(await settledHostCloses()).toEqual([
      { worktreeId: WT, tabId: splitTab.id, environmentId: ENV, reason: 'user' }
    ])
  })

  it('keeps the host tab when Save closes a host-only dirty file', async () => {
    seed([readmeTab], true)
    const detach = attachEditorAutosaveController(useAppStore)
    try {
      window.dispatchEvent(
        new CustomEvent<EditorSaveAndCloseDetail>(ORCA_EDITOR_SAVE_AND_CLOSE_EVENT, {
          detail: { fileId: readmePath, tabId: readmeTab.id }
        })
      )
      await vi.waitFor(() => expect(useAppStore.getState().openFiles).toEqual([]))
    } finally {
      detach()
    }

    expect(await settledHostCloses()).toEqual([])
  })
})
