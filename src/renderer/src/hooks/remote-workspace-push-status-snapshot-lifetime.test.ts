import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RemoteWorkspaceObservedPatchResult } from '../../../shared/remote-workspace-types'
import { useAppStore } from '@/store'
import { snapshot } from './__tests__/remote-workspace-target-sync-test-harness'
import {
  applyRemoteWorkspacePushStatus,
  type RemoteWorkspacePushAuthority
} from './remote-workspace-push-status'

const TARGET_ID = 'target-a'
const NOW = 100
const initialAppStoreState = useAppStore.getState()
const unavailableMessage = 'Remote workspace sync unavailable'
const conflictMessage = 'Workspace changed on another device'
const fallbackResponses = [
  { name: 'missing reply', result: undefined, phase: 'offline', message: unavailableMessage },
  {
    name: 'snapshot-free conflict',
    result: { ok: false, reason: 'stale-revision' },
    phase: 'conflict',
    message: conflictMessage
  },
  {
    name: 'snapshot-free unavailable',
    result: { ok: false, reason: 'unavailable' },
    phase: 'offline',
    message: unavailableMessage
  }
] as const

async function collectRetiredSnapshots(): Promise<void> {
  if (typeof globalThis.gc !== 'function') {
    throw new Error('Run with the repository Vitest --expose-gc config')
  }
  for (let round = 0; round < 3; round += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve))
    globalThis.gc()
  }
}

function publishFailedSnapshot(reason: 'stale-revision' | 'unavailable') {
  const observed = snapshot(8)
  const leafId = '11111111-1111-4111-8111-111111111111'
  observed.session.activeWorktreePath = '/remote/work'
  observed.session.activeTabId = 'host-tab'
  observed.session.tabsByWorktreePath = {
    '/remote/work': [
      {
        id: 'host-tab',
        worktreePath: '/remote/work',
        ptyId: null,
        title: 'Agent',
        customTitle: null,
        color: null,
        sortOrder: 0,
        createdAt: 1
      }
    ]
  }
  observed.session.terminalLayoutsByTabId = {
    'host-tab': {
      root: { type: 'leaf', leafId },
      activeLeafId: leafId,
      expandedLeafId: null,
      buffersByLeafId: { [leafId]: 'Agent progress\n'.repeat(4_096) }
    }
  }
  const retiredSession = new WeakRef(observed.session)
  applyRemoteWorkspacePushStatus(
    useAppStore.getState(),
    TARGET_ID,
    { ok: false, reason, snapshot: observed, message: 'Retry upload' },
    { revision: 0, hostObservationToken: 'older-observation' }
  )
  useAppStore.getState().setSshConnectionState(TARGET_ID, {
    targetId: TARGET_ID,
    status: 'disconnected',
    error: null,
    reconnectAttempt: 0
  })
  return retiredSession
}

beforeEach(() => {
  useAppStore.setState(initialAppStoreState, true)
  vi.spyOn(Date, 'now').mockReturnValue(NOW)
})

afterEach(() => {
  useAppStore.setState(initialAppStoreState, true)
  vi.restoreAllMocks()
})

describe('remote workspace push status snapshot lifetime', () => {
  it.each(['stale-revision', 'unavailable'] as const)(
    'releases the %s session while its status survives disconnect',
    async (reason) => {
      const retiredSession = publishFailedSnapshot(reason)
      const status = useAppStore.getState().remoteWorkspaceSyncStatusByTargetId[TARGET_ID]
      const expected = {
        phase: reason === 'stale-revision' ? 'conflict' : 'offline',
        direction: 'push',
        revision: 8,
        updatedAt: 8,
        hostObservationToken: 'observation-8',
        lastSyncedAt: NOW,
        message: 'Retry upload'
      }
      expect(status).toMatchObject(expected)
      expect(useAppStore.getState().sshConnectionStates.get(TARGET_ID)?.status).toBe('disconnected')

      await collectRetiredSnapshots()
      expect(retiredSession.deref()).toBeUndefined()
      expect(status).toEqual(expected)
      expect(Object.keys(status)).toEqual(Object.keys(expected))
    }
  )

  it('preserves a successful upload status', () => {
    applyRemoteWorkspacePushStatus(
      useAppStore.getState(),
      TARGET_ID,
      { ok: true, snapshot: snapshot(9) },
      { revision: 0, hostObservationToken: 'older-observation' }
    )
    expect(useAppStore.getState().remoteWorkspaceSyncStatusByTargetId[TARGET_ID]).toEqual({
      phase: 'synced',
      direction: 'push',
      revision: 9,
      updatedAt: 9,
      hostObservationToken: 'observation-9',
      lastSyncedAt: NOW,
      message: 'Workspace uploaded'
    })
  })

  it.each(fallbackResponses)('preserves full observed fallback keys for $name', (response) => {
    const fallback = snapshot(0)
    applyRemoteWorkspacePushStatus(useAppStore.getState(), TARGET_ID, response.result, fallback)
    const status = useAppStore.getState().remoteWorkspaceSyncStatusByTargetId[TARGET_ID]
    const expected = {
      phase: response.phase,
      direction: 'push',
      ...fallback,
      lastSyncedAt: NOW,
      message: response.message
    }
    expect(status).toEqual(expected)
    expect(Object.keys(status)).toEqual(Object.keys(expected))
    const retainedStatus: unknown = status
    if (
      typeof retainedStatus !== 'object' ||
      retainedStatus === null ||
      !('session' in retainedStatus)
    ) {
      throw new Error('The full observed fallback keeps its existing session property')
    }
    expect(retainedStatus.session).toBe(fallback.session)
  })

  it.each([{}, { updatedAt: undefined }, { updatedAt: 13 }] as const)(
    'preserves fallback updatedAt own-key presence: %j',
    (extra) => {
      const fallback: RemoteWorkspacePushAuthority = {
        revision: 7,
        hostObservationToken: 'fallback-observation',
        ...extra
      }
      applyRemoteWorkspacePushStatus(useAppStore.getState(), TARGET_ID, undefined, fallback)
      const status = useAppStore.getState().remoteWorkspaceSyncStatusByTargetId[TARGET_ID]
      expect(status).toEqual({
        phase: 'offline',
        direction: 'push',
        ...fallback,
        lastSyncedAt: NOW,
        message: unavailableMessage
      })
      expect(Object.hasOwn(status, 'updatedAt')).toBe(Object.hasOwn(fallback, 'updatedAt'))
    }
  )

  it.each(fallbackResponses)('preserves matching transient authority for $name', (response) => {
    const fallback = snapshot(0)
    useAppStore.getState().setRemoteWorkspaceSyncStatus(TARGET_ID, {
      phase: 'pulling',
      revision: -1,
      updatedAt: undefined,
      hostObservationToken: fallback.hostObservationToken
    })
    applyRemoteWorkspacePushStatus(useAppStore.getState(), TARGET_ID, response.result, fallback)
    const status = useAppStore.getState().remoteWorkspaceSyncStatusByTargetId[TARGET_ID]
    expect(status).toEqual({
      phase: response.phase,
      direction: 'push',
      revision: -1,
      updatedAt: undefined,
      hostObservationToken: fallback.hostObservationToken,
      lastSyncedAt: NOW,
      message: response.message
    })
    expect(Object.hasOwn(status, 'updatedAt')).toBe(true)
    expect(Object.hasOwn(status, 'session')).toBe(false)
  })

  it('preserves an empty custom failure message', () => {
    const result: RemoteWorkspaceObservedPatchResult = {
      ok: false,
      reason: 'stale-revision',
      snapshot: snapshot(10),
      message: ''
    }
    applyRemoteWorkspacePushStatus(useAppStore.getState(), TARGET_ID, result, snapshot(0))
    expect(useAppStore.getState().remoteWorkspaceSyncStatusByTargetId[TARGET_ID]).toMatchObject({
      phase: 'conflict',
      direction: 'push',
      revision: 10,
      updatedAt: 10,
      hostObservationToken: 'observation-10',
      lastSyncedAt: NOW,
      message: ''
    })
  })
})
