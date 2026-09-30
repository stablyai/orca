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
