import { describe, expect, it } from 'vitest'

import {
  structuredAgentSessionCreateParams,
  type StructuredAgentSessionFirstMessage,
  type StructuredAgentSessionResumeSource
} from './structured-agent-session-create'

const SESSION_ID = 'codex_11111111_2222_3333_4444_555555555555'

/** Distinct per call so two envelopes never share an operation id by accident. */
let uuidCounter = 0
function nextUuid(): string {
  uuidCounter += 1
  return `00000000-0000-4000-8000-${String(uuidCounter).padStart(12, '0')}`
}

function createParams(
  overrides: {
    resumeFrom?: StructuredAgentSessionResumeSource
    tabId?: string
    firstMessage?: StructuredAgentSessionFirstMessage
    options?: Record<string, string>
  } = {}
) {
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
  it('leaves a blank create byte-identical to the pre-resume digest', () => {
    expect(createParams().envelope.payloadFingerprint).toBe(
      '56cb15e22414c0f62fd89d77d00d2d6a0a422f16e95edee154fb8b5bf53fbbc3'
    )
  })
})
