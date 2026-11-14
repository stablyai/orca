// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tab } from '../../../../../shared/tab-types'
import type { OpenFile } from '../../../store/slices/editor/types/open-file'

const closeWebRuntimeSessionTabMock = vi.fn(async (_args: unknown) => 'applied' as const)

vi.mock('../actions/web-runtime-session-tab-lifecycle', () => ({
  closeWebRuntimeSessionTab: (args: unknown) => closeWebRuntimeSessionTabMock(args)
}))

import { useAppStore } from '../../../store/index'
import {
  ENV,
  NOW,
  WT,
  resetWebSessionTabsSyncTestState
} from '../testing/web-session-tabs-sync.test-fixture'

const videoPath = '/repo/out/final.mp4'
const hostTabId = 'host-video-tab'

// The host's tab id lives only on the unified tab; the file is keyed by its local id.
const videoUnifiedTab: Tab = {
  id: hostTabId,
  entityId: videoPath,
  groupId: 'host-group-1',
  worktreeId: WT,
  contentType: 'editor',
  label: 'final.mp4',
  customLabel: null,
  color: null,
  sortOrder: 0,
  createdAt: NOW - 10,
  isPreview: false,
  isPinned: false
}

const mirroredVideo: OpenFile = {
  id: videoPath,
  filePath: videoPath,
  relativePath: 'out/final.mp4',
  worktreeId: WT,
  language: 'plaintext',
  isDirty: false,
  runtimeEnvironmentId: ENV,
  mode: 'edit',
  mirroredFromRuntimeSession: true
}

describe('tab-strip close of a clean host-mirrored editor tab', () => {
  const initialState = useAppStore.getState()

  beforeEach(() => {
    resetWebSessionTabsSyncTestState()
    closeWebRuntimeSessionTabMock.mockClear()
    useAppStore.setState({
      ...initialState,
      activeWorktreeId: WT,
      openFiles: [mirroredVideo],
      unifiedTabsByWorktree: { [WT]: [videoUnifiedTab] }
    })
  })

  afterEach(() => {
    useAppStore.setState(initialState, true)
  })

  it('tells the host to retire its tab, or the next host snapshot reopens it', async () => {
    useAppStore.getState().closeUnifiedTab(hostTabId)

    // The host RPC module is imported lazily.
    await vi.waitFor(() => expect(closeWebRuntimeSessionTabMock).toHaveBeenCalledTimes(1))
    expect(closeWebRuntimeSessionTabMock).toHaveBeenCalledWith({
      worktreeId: WT,
      tabId: hostTabId,
      environmentId: ENV,
      reason: 'user'
    })
    const state = useAppStore.getState()
    expect(state.unifiedTabsByWorktree[WT] ?? []).toEqual([])
    expect(state.openFiles.some((file) => file.id === videoPath)).toBe(false)
  })
})
