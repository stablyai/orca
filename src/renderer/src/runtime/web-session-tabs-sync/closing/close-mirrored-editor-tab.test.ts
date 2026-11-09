import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ResolveOwnerModule from '@/lib/workspace/ownership/resolve-owner'

const closeWebRuntimeSessionTabMock = vi.fn()
const ownerLookup = vi.hoisted(() => ({ calls: 0 }))

vi.mock('../actions/web-runtime-session-tab-lifecycle', () => ({
  closeWebRuntimeSessionTab: (args: unknown) => closeWebRuntimeSessionTabMock(args)
}))

vi.mock('@/lib/workspace/ownership/resolve-owner', async (importOriginal) => {
  const actual = await importOriginal<typeof ResolveOwnerModule>()
  return {
    ...actual,
    runtimeEnvironmentIdUnlessTwin: (
      ...args: Parameters<typeof actual.runtimeEnvironmentIdUnlessTwin>
    ) => {
      ownerLookup.calls += 1
      return actual.runtimeEnvironmentIdUnlessTwin(...args)
    }
  }
})

import {
  notifyHostOfMirroredEditorClose,
  type MirroredEditorCloseState
} from './close-mirrored-editor-tab'
import {
  isWebSessionCloseIntentPending,
  resetWebSessionCloseIntentForTests
} from './web-session-close-intent'
import { toHostSessionTabId } from '../../../../../shared/workspace-layout/terminal-surface-id'

type OwnerHost = 'local' | 'runtime:env-1'

function ownerRows(...hostIds: OwnerHost[]): Partial<MirroredEditorCloseState> {
  return {
    repos: hostIds.map((hostId) => ({ id: 'repo', executionHostId: hostId })),
    worktreesByRepo: {
      repo: hostIds.map((hostId) => ({
        id: 'wt-1',
        repoId: 'repo',
        hostId,
        ...(hostId === 'local' ? {} : { runtimeOwnerEnvironmentId: 'env-1' })
      }))
    }
  }
}

function buildState(overrides: Partial<MirroredEditorCloseState> = {}): MirroredEditorCloseState {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: fixture rows carry only the fields notifyHostOfMirroredEditorClose and the owner resolver read.
  return {
    ...ownerRows('runtime:env-1'),
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
    ownerLookup.calls = 0
    resetWebSessionCloseIntentForTests()
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
    expect(ownerLookup.calls).toBe(0)
  })
})
