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

  it('records and sends a close for every host tab linked to the document', async () => {
    const state = buildState()
    const original = state.unifiedTabsByWorktree['wt-1'][0]
    if (!original) {
      throw new Error('Missing editor tab')
    }
    state.unifiedTabsByWorktree['wt-1'].push(
      { ...original, id: 'host-tab-2', groupId: 'second-pane' },
      { ...original, id: 'unrelated-tab', entityId: 'another-document' }
    )
    expect(notifyHostOfMirroredEditorClose(state, 'wt-1', 'file-1')).toBe(true)
    for (const tabId of ['host-tab-1', 'host-tab-2']) {
      expect(
        isWebSessionCloseIntentPending(
          { environmentId: 'env-1' },
          'wt-1',
          toHostSessionTabId(tabId),
          Date.now()
        )
      ).toBe(true)
    }
    await vi.waitFor(() => expect(closeWebRuntimeSessionTabMock).toHaveBeenCalledTimes(2))
    expect(closeWebRuntimeSessionTabMock.mock.calls.map(([args]) => args.tabId)).toEqual([
      'host-tab-1',
      'host-tab-2'
    ])
  })

  it('routes to the captured file owner when the workspace catalog disagrees', async () => {
    const state = buildState()
    state.openFiles = state.openFiles.map((file) => ({ ...file, runtimeEnvironmentId: 'env-2' }))

    expect(notifyHostOfMirroredEditorClose(state, 'wt-1', 'file-1')).toBe(true)
    expect(
      isWebSessionCloseIntentPending(
        { environmentId: 'env-2' },
        'wt-1',
        toHostSessionTabId('host-tab-1'),
        Date.now()
      )
    ).toBe(true)
    await vi.waitFor(() =>
      expect(closeWebRuntimeSessionTabMock).toHaveBeenCalledWith({
        worktreeId: 'wt-1',
        tabId: 'host-tab-1',
        environmentId: 'env-2',
        reason: 'user'
      })
    )
    expect(getRuntimeEnvironmentIdForWorktreeMock).not.toHaveBeenCalled()
  })

  it('does not infer a remote owner for an explicitly local file', () => {
    const state = buildState()
    state.openFiles = state.openFiles.map((file) => ({ ...file, runtimeEnvironmentId: null }))

    expect(notifyHostOfMirroredEditorClose(state, 'wt-1', 'file-1')).toBe(false)
    expect(getRuntimeEnvironmentIdForWorktreeMock).not.toHaveBeenCalled()
    expect(closeWebRuntimeSessionTabMock).not.toHaveBeenCalled()
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
