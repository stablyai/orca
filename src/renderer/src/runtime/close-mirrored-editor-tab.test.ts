import { beforeEach, describe, expect, it, vi } from 'vitest'

const closeWebRuntimeSessionTabMock = vi.fn()
const getRuntimeEnvironmentIdForWorktreeMock = vi.fn()

vi.mock('./web-runtime-session', () => ({
  closeWebRuntimeSessionTab: (args: unknown) => closeWebRuntimeSessionTabMock(args)
}))

vi.mock('@/lib/worktree-runtime-owner', () => ({
  getRuntimeEnvironmentIdForWorktree: (...args: unknown[]) =>
    getRuntimeEnvironmentIdForWorktreeMock(...args)
}))

import {
  notifyHostOfMirroredEditorClose,
  type MirroredEditorCloseState
} from './close-mirrored-editor-tab'
import {
  isWebSessionCloseIntentPending,
  resetWebSessionCloseIntentForTests
} from './web-session-close-intent'
import { toHostSessionTabId } from '../../../shared/terminal-surface-id'
import type { Tab } from '../../../shared/tab-types'

function mirroredEditorTab(id: string): Tab {
  return {
    id,
    entityId: 'file-1',
    groupId: 'group-1',
    worktreeId: 'wt-1',
    contentType: 'editor',
    label: id,
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

function buildState(overrides: Partial<MirroredEditorCloseState> = {}): MirroredEditorCloseState {
  return {
    openFiles: [{ id: 'file-1', worktreeId: 'wt-1', mirroredFromRuntimeSession: true }],
    unifiedTabsByWorktree: {
      'wt-1': [{ id: 'host-tab-1', entityId: 'file-1', contentType: 'editor' }]
    },
    ...overrides
  } as unknown as MirroredEditorCloseState
}

describe('notifyHostOfMirroredEditorClose', () => {
  beforeEach(() => {
    closeWebRuntimeSessionTabMock.mockReset()
    getRuntimeEnvironmentIdForWorktreeMock.mockReset()
    getRuntimeEnvironmentIdForWorktreeMock.mockReturnValue('env-1')
    resetWebSessionCloseIntentForTests()
  })

  it('records the host close intent SYNCHRONOUSLY (before the async close resolves)', () => {
    const now = Date.now()
    // No await: the intent must be pending the instant the call returns, so a
    // host snapshot in the dynamic-import gap can't flash the old-path tab back.
    notifyHostOfMirroredEditorClose(buildState(), 'wt-1', 'file-1')

    expect(
      isWebSessionCloseIntentPending(
        { environmentId: 'env-1' },
        'wt-1',
        toHostSessionTabId('host-tab-1'),
        now
      )
    ).toBe(true)
  })

  it('closes the mirrored editor tab on the host using the host tab id', async () => {
    const handled = notifyHostOfMirroredEditorClose(buildState(), 'wt-1', 'file-1')

    expect(handled).toBe(true)
    await vi.waitFor(() => {
      expect(closeWebRuntimeSessionTabMock).toHaveBeenCalled()
    })
    expect(closeWebRuntimeSessionTabMock).toHaveBeenCalledWith({
      worktreeId: 'wt-1',
      tabId: 'host-tab-1',
      environmentId: 'env-1',
      reason: 'user'
    })
  })

  it('closes every mirrored tab that renders the file, not just the first', async () => {
    const now = Date.now()
    const state = buildState({
      unifiedTabsByWorktree: {
        'wt-1': [mirroredEditorTab('host-tab-1'), mirroredEditorTab('host-tab-2')]
      }
    })

    const handled = notifyHostOfMirroredEditorClose(state, 'wt-1', 'file-1')

    expect(handled).toBe(true)
    for (const tabId of ['host-tab-1', 'host-tab-2']) {
      expect(
        isWebSessionCloseIntentPending(
          { environmentId: 'env-1' },
          'wt-1',
          toHostSessionTabId(tabId),
          now
        )
      ).toBe(true)
    }
    await vi.waitFor(() => {
      expect(closeWebRuntimeSessionTabMock).toHaveBeenCalledTimes(2)
    })
    for (const tabId of ['host-tab-1', 'host-tab-2']) {
      expect(closeWebRuntimeSessionTabMock).toHaveBeenCalledWith({
        worktreeId: 'wt-1',
        tabId,
        environmentId: 'env-1',
        reason: 'user'
      })
    }
  })

  it('does not route locally-opened (non-mirrored) files to the host', () => {
    const state = buildState({
      openFiles: [
        { id: 'file-1', worktreeId: 'wt-1' }
      ] as unknown as MirroredEditorCloseState['openFiles']
    })

    const handled = notifyHostOfMirroredEditorClose(state, 'wt-1', 'file-1')

    expect(handled).toBe(false)
    expect(closeWebRuntimeSessionTabMock).not.toHaveBeenCalled()
  })

  it('does nothing when no web runtime session is active', () => {
    getRuntimeEnvironmentIdForWorktreeMock.mockReturnValue(null)

    const handled = notifyHostOfMirroredEditorClose(buildState(), 'wt-1', 'file-1')

    expect(handled).toBe(false)
    expect(closeWebRuntimeSessionTabMock).not.toHaveBeenCalled()
  })
})
