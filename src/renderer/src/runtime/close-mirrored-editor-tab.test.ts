import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ResolveOwnerModule from '@/lib/resolve-owner'

const closeWebRuntimeSessionTabMock = vi.fn()
const ownerLookup = vi.hoisted(() => ({ calls: 0 }))

vi.mock('./web-runtime-session-tab-lifecycle', () => ({
  closeWebRuntimeSessionTab: (args: unknown) => closeWebRuntimeSessionTabMock(args)
}))

vi.mock('@/lib/resolve-owner', async (importOriginal) => {
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
import { toHostSessionTabId } from '../../../shared/terminal-surface-id'

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

  it('records the host close intent SYNCHRONOUSLY (before the async close resolves)', () => {
    const now = Date.now()
    // Intent must exist synchronously or a snapshot during dynamic import can flash the old path back.
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
    expect(ownerLookup.calls).toBe(0)
  })

  it('refuses a legacy mirrored file whose worktree is a local twin of the server', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const handled = notifyHostOfMirroredEditorClose(
      buildState(ownerRows('local', 'runtime:env-1')),
      'wt-1',
      'file-1'
    )

    expect(handled).toBe(false)
    expect(
      isWebSessionCloseIntentPending(
        { environmentId: 'env-1' },
        'wt-1',
        toHostSessionTabId('host-tab-1'),
        Date.now()
      )
    ).toBe(false)
    expect(closeWebRuntimeSessionTabMock).not.toHaveBeenCalled()
    expect(warn.mock.calls[0]).toContain('wt-1')
    warn.mockRestore()
  })
})
