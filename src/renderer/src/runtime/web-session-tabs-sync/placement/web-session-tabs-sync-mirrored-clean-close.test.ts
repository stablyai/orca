// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tab } from '../../../../../shared/workspace-layout/tab-groups/tab-types'
import type { OpenFile } from '../../../store/slices/editor/types/open-file'

const closeWebRuntimeSessionTabMock = vi.fn(async (_args: unknown) => 'applied' as const)

vi.mock('../actions/web-runtime-session-tab-lifecycle', () => ({
  closeWebRuntimeSessionTab: (args: unknown) => closeWebRuntimeSessionTabMock(args)
}))

import { useAppStore } from '../../../store/index'
import { createWorkspaceTabCloseCommands } from '@/components/tab-group/workspace-tab-close-commands'
import {
  ENV,
  NOW,
  WT,
  resetWebSessionTabsSyncTestState
} from '../testing/web-session-tabs-sync.test-fixture'

const readmePath = '/repo/README.md'

const readmeUnifiedTab: Tab = {
  id: 'host-readme-unified',
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

const cleanMirroredReadme: OpenFile = {
  id: readmePath,
  filePath: readmePath,
  relativePath: 'README.md',
  worktreeId: WT,
  language: 'markdown',
  isDirty: false,
  runtimeEnvironmentId: ENV,
  mode: 'edit',
  mirroredFromRuntimeSession: true
}

describe('tab-strip close of a clean host-mirrored file', () => {
  const initialState = useAppStore.getState()

  beforeEach(() => {
    resetWebSessionTabsSyncTestState()
    closeWebRuntimeSessionTabMock.mockClear()
    useAppStore.setState({
      ...initialState,
      activeWorktreeId: WT,
      openFiles: [cleanMirroredReadme],
      unifiedTabsByWorktree: { [WT]: [readmeUnifiedTab] }
    })
  })

  afterEach(() => {
    useAppStore.setState(initialState, true)
  })

  it('tells the host to close the tab so its next snapshot does not reopen it', async () => {
    createWorkspaceTabCloseCommands({ worktreeId: WT, groupTabs: [readmeUnifiedTab] }).closeItem(
      readmeUnifiedTab.id
    )

    await vi.waitFor(() => {
      expect(closeWebRuntimeSessionTabMock).toHaveBeenCalledWith({
        worktreeId: WT,
        tabId: 'host-readme-unified',
        environmentId: ENV,
        reason: 'user'
      })
    })
    expect(closeWebRuntimeSessionTabMock).toHaveBeenCalledTimes(1)
    expect(useAppStore.getState().unifiedTabsByWorktree[WT] ?? []).toEqual([])
  })
})
