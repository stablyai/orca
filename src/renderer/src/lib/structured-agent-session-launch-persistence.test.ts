// @vitest-environment happy-dom

import { beforeEach, describe, expect, it } from 'vitest'
import {
  hasStructuredAgentLaunchCancellationTombstonePersisted,
  readStructuredAgentLaunchRecord,
  resetStructuredAgentLaunchPersistenceForTests,
  retireStructuredAgentLaunchCancellationTombstonePersisted,
  writeStructuredAgentLaunchRecord,
  markStructuredAgentLaunchCancelledPersisted
} from './structured-agent-session-launch-persistence'

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
          agent: 'codex',
          lifecycle: 'pending',
          clientOperationId: 'operation-1',
          payloadFingerprint: 'fingerprint-1',
          expectedRuntimeFence: null
        }
      ])
    )

    expect(readStructuredAgentLaunchRecord('codex_session')).toMatchObject({
      lifecycle: 'visibility-unknown',
      clientOperationId: 'operation-1'
    })
  })

  it('stores only content-free identity and preserves operation identity', () => {
    writeStructuredAgentLaunchRecord({
      sessionId: 'claude_session',
      agent: 'claude',
      lifecycle: 'visibility-unknown',
      clientOperationId: 'operation-2',
      payloadFingerprint: 'fingerprint-2',
      expectedRuntimeFence: null,
      resumeFrom: { providerSessionId: 'provider-thread' }
    })

    const raw = localStorage.getItem('orca:structuredAgentLaunches:v1') ?? ''
    expect(raw).toContain('claude_session')
    expect(raw).toContain('operation-2')
    expect(raw).not.toContain('prompt')
    expect(raw).not.toContain('branch')
    expect(raw).not.toContain('path')
    expect(readStructuredAgentLaunchRecord('claude_session')?.clientOperationId).toBe('operation-2')
  })

  it('keeps when a failed launch failed across a reload, and still loads records without it', () => {
    writeStructuredAgentLaunchRecord({
      sessionId: 'claude_session',
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

  it('persists cancellation tombstones by session id and retires them', () => {
    markStructuredAgentLaunchCancelledPersisted('codex_session')
    expect(hasStructuredAgentLaunchCancellationTombstonePersisted('codex_session')).toBe(true)
    expect(localStorage.getItem('orca:structuredAgentLaunchCancelledSessions:v1')).toBe(
      '["codex_session"]'
    )
    expect(retireStructuredAgentLaunchCancellationTombstonePersisted('codex_session')).toBe(true)
    expect(hasStructuredAgentLaunchCancellationTombstonePersisted('codex_session')).toBe(false)
  })
})
