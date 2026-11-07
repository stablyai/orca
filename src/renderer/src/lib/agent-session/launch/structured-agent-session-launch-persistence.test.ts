// @vitest-environment happy-dom

import { beforeEach, describe, expect, it } from 'vitest'
import {
  hasStructuredAgentLaunchCancellationTombstonePersisted,
  readStructuredAgentLaunchRecord,
  resetStructuredAgentLaunchPersistenceForTests,
  readStructuredAgentLaunchCancellationTombstoneSessionIds,
  retireAbsentStructuredAgentLaunchCancellationTombstonesPersisted,
  writeStructuredAgentLaunchRecord,
  markStructuredAgentLaunchCancelledPersisted
} from './structured-agent-session-launch-persistence'

import { structuredAgentLaunchRecordFor } from './structured-agent-session-launch-record'
import type { StructuredAgentSessionLaunchIntent } from '../../launch-structured-agent-session'

const SERVER = 'runtime:server-1'
const TOMBSTONES_KEY = 'orca:structuredAgentLaunchCancelledSessions:v1'

function reload(): void {
  resetStructuredAgentLaunchPersistenceForTests()
}

describe('structured agent launch persistence', () => {
  beforeEach(() => {
    localStorage.clear()
    resetStructuredAgentLaunchPersistenceForTests()
  })

  it('normalizes pending launches after a renderer reload', () => {
    localStorage.setItem(
      'orca:structuredAgentLaunches:v1',
      JSON.stringify([
        {
          sessionId: 'codex_session',
          surfaceAddress: {
            worktreeId: 'repo::/workspace',
            targetGroupId: 'original',
            precedingTabIds: ['source']
          },
          agent: 'codex',
          lifecycle: 'pending',
          clientOperationId: 'operation-1',
          payloadFingerprint: 'fingerprint-1',
          expectedRuntimeFence: null
        }
      ])
    )

    expect(readStructuredAgentLaunchRecord('codex_session')).toMatchObject({
      surfaceAddress: {
        worktreeId: 'repo::/workspace',
        targetGroupId: 'original',
        precedingTabIds: ['source']
      },
      lifecycle: 'visibility-unknown',
      clientOperationId: 'operation-1',
      // Written before a paired host could hold a chat, so it was launched on this machine.
      executionHostId: 'local'
    })
  })

  // This machine cannot re-derive a paired server's seed, so a reload must show the same one.
  it("keeps a paired server's reported seed across a reload, and no local one", () => {
    const intent = (
      executionHostId: 'local' | typeof SERVER,
      sessionId: string
    ): StructuredAgentSessionLaunchIntent => ({
      sessionId,
      worktreeId: 'workspace-1',
      executionHostId,
      target:
        executionHostId === 'local'
          ? { kind: 'local' }
          : { kind: 'environment', environmentId: 'server-1' },
      agent: 'claude',
      params: {
        envelope: {
          sessionId,
          clientOperationId: 'operation-9',
          expectedRuntimeFence: null,
          payloadFingerprint: 'fingerprint-9'
        },
        worktree: 'id:workspace-1',
        agent: 'claude'
      },
      seedOptions: { model: 'opus', fastMode: 'true' }
    })
    writeStructuredAgentLaunchRecord(
      structuredAgentLaunchRecordFor(intent(SERVER, 'claude_paired'), 'pending')
    )
    writeStructuredAgentLaunchRecord(
      structuredAgentLaunchRecordFor(intent('local', 'claude_local'), 'pending')
    )
    reload()

    expect(readStructuredAgentLaunchRecord('claude_paired')?.seedOptions).toEqual({
      model: 'opus',
      fastMode: 'true'
    })
    expect(readStructuredAgentLaunchRecord('claude_local')?.seedOptions).toBeUndefined()
  })

  it('keeps when a failed launch failed across a reload, and still loads records without it', () => {
    writeStructuredAgentLaunchRecord({
      sessionId: 'claude_session',
      executionHostId: 'local',
      agent: 'claude',
      lifecycle: 'failed',
      clientOperationId: 'operation-3',
      payloadFingerprint: 'fingerprint-3',
      expectedRuntimeFence: null,
      failedAt: 42_000
    })
    const stored = JSON.parse(localStorage.getItem('orca:structuredAgentLaunches:v1') ?? '[]')
    localStorage.setItem(
      'orca:structuredAgentLaunches:v1',
      JSON.stringify([
        ...stored,
        // Written by a build that did not save the failure time.
        { ...stored[0], sessionId: 'older_session', failedAt: undefined },
        { ...stored[0], sessionId: 'corrupt_session', failedAt: 'yesterday' }
      ])
    )
    resetStructuredAgentLaunchPersistenceForTests()

    expect(readStructuredAgentLaunchRecord('claude_session')).toMatchObject({
      lifecycle: 'failed',
      failedAt: 42_000
    })
    expect(readStructuredAgentLaunchRecord('older_session')).toMatchObject({ lifecycle: 'failed' })
    expect(readStructuredAgentLaunchRecord('older_session')?.failedAt).toBeUndefined()
    expect(readStructuredAgentLaunchRecord('corrupt_session')).toBeUndefined()
  })

  it("keeps a paired host's tombstone under that host across a reload", () => {
    markStructuredAgentLaunchCancelledPersisted('remote_session', SERVER)
    markStructuredAgentLaunchCancelledPersisted('local_session', 'local')
    reload()

    expect(readStructuredAgentLaunchCancellationTombstoneSessionIds(SERVER)).toEqual([
      'remote_session'
    ])
    expect(readStructuredAgentLaunchCancellationTombstoneSessionIds('local')).toEqual([
      'local_session'
    ])
  })

  it('retires only the tombstones of the host whose inventory omitted them', () => {
    markStructuredAgentLaunchCancelledPersisted('remote_session', SERVER)
    markStructuredAgentLaunchCancelledPersisted('local_session', 'local')

    expect(
      retireAbsentStructuredAgentLaunchCancellationTombstonesPersisted(new Set(), 'local')
    ).toBe(true)
    expect(hasStructuredAgentLaunchCancellationTombstonePersisted('local_session')).toBe(false)
    expect(hasStructuredAgentLaunchCancellationTombstonePersisted('remote_session')).toBe(true)
  })

  it("expires a paired host's tombstone that host never answered for", () => {
    const expired = Date.now() - 31 * 24 * 60 * 60 * 1000
    localStorage.setItem(
      TOMBSTONES_KEY,
      JSON.stringify([
        { sessionId: 'stale_remote', executionHostId: SERVER, cancelledAt: expired },
        { sessionId: 'fresh_remote', executionHostId: SERVER, cancelledAt: Date.now() }
      ])
    )

    expect(hasStructuredAgentLaunchCancellationTombstonePersisted('stale_remote')).toBe(false)
    expect(hasStructuredAgentLaunchCancellationTombstonePersisted('fresh_remote')).toBe(true)
  })
})
