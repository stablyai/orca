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
import './structured-agent-session-launch-record'

const SERVER = 'runtime:server-1'
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
    ).toEqual(['local_session'])
    expect(hasStructuredAgentLaunchCancellationTombstonePersisted('local_session')).toBe(false)
    expect(hasStructuredAgentLaunchCancellationTombstonePersisted('remote_session')).toBe(true)
  })
})
