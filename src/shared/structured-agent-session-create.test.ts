import { describe, expect, it } from 'vitest'
import { structuredAgentSessionCreateParams } from './structured-agent-session-create'
import {
  structuredAgentSessionCreateFingerprint,
  structuredAgentSessionPayloadFingerprint
} from './structured-agent-session-mutation'

const SESSION_ID = 'codex_11111111_2222_3333_4444_555555555555'
const RESUME = { providerSessionId: 'thread-abc' }

/** Distinct per call so two envelopes never share an operation id by accident. */
let uuidCounter = 0
function nextUuid(): string {
  uuidCounter += 1
  return `00000000-0000-4000-8000-${String(uuidCounter).padStart(12, '0')}`
}

function createParams(overrides: { resumeFrom?: { providerSessionId: string } } = {}) {
  return structuredAgentSessionCreateParams({
    sessionId: SESSION_ID,
    worktree: 'id:repo-1::/repo/orca',
    agent: 'codex',
    ...overrides,
    randomUuid: nextUuid,
    now: 1_800_000_000_000
  })
}

describe('structured agent session create params', () => {
  it('carries resumeFrom only when the create adopts a conversation', () => {
    expect(createParams()).not.toHaveProperty('resumeFrom')
    expect(createParams({ resumeFrom: RESUME })).toMatchObject({ resumeFrom: RESUME })
  })

  it('declares a fingerprint the host can recompute from the same fields', () => {
    const params = createParams({ resumeFrom: RESUME })

    expect(params.envelope.payloadFingerprint).toBe(
      structuredAgentSessionCreateFingerprint({
        sessionId: SESSION_ID,
        worktree: 'id:repo-1::/repo/orca',
        agent: 'codex',
        resumeFrom: RESUME
      })
    )
  })

  it('separates an adopting create from a blank one and from another row', () => {
    const blank = createParams().envelope.payloadFingerprint
    const adopted = createParams({ resumeFrom: RESUME }).envelope.payloadFingerprint
    const otherRow = createParams({
      resumeFrom: { providerSessionId: 'thread-other' }
    }).envelope.payloadFingerprint

    expect(adopted).not.toBe(blank)
    expect(otherRow).not.toBe(adopted)
  })

  it('gives a replay of the same adoption the same digest under a new operation id', () => {
    const first = createParams({ resumeFrom: RESUME })
    const second = createParams({ resumeFrom: RESUME })

    expect(second.envelope.clientOperationId).not.toBe(first.envelope.clientOperationId)
    expect(second.envelope.payloadFingerprint).toBe(first.envelope.payloadFingerprint)
  })

  it('leaves a blank create byte-identical to the pre-resume digest', () => {
    // Pinned literal: a create with no `resumeFrom` must keep the digest older clients and hosts
    // already compute, so adding a field to the create fingerprint fails here rather than in the
    // field on a mixed-version pair.
    expect(createParams().envelope.payloadFingerprint).toBe(
      structuredAgentSessionPayloadFingerprint({
        method: 'agentSession.create',
        sessionId: SESSION_ID,
        fields: { worktree: 'id:repo-1::/repo/orca', agent: 'codex' }
      })
    )
    expect(createParams().envelope.payloadFingerprint).toBe(
      '56cb15e22414c0f62fd89d77d00d2d6a0a422f16e95edee154fb8b5bf53fbbc3'
    )
  })
})
