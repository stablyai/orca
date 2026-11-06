import { ResumeSource } from '../rpc-contract/structured-agent-session-params'
import { STRUCTURED_AGENT_SESSION_CLI_SOURCE_RUNTIME_CAPABILITY } from './structured-agent-session-surface-capabilities'
import { describe, expect, it } from 'vitest'
import { RUNTIME_CAPABILITIES } from '../protocol-version'
import './agent-session-create-capabilities'

import {
  structuredAgentSessionCreateParams,
  type StructuredAgentSessionFirstMessage,
  type StructuredAgentSessionResumeSource
} from './structured-agent-session-create'
import { structuredAgentSessionPayloadFingerprint } from './lifecycle/structured-agent-session-mutation'

const SESSION_ID = 'codex_11111111_2222_3333_4444_555555555555'
const RESUME = { providerSessionId: 'thread-abc' }

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
    // Pin the legacy no-resume digest; new fields must not break mixed-version create fingerprints.
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

it('negotiates a strict pane identity and includes it in the create fingerprint without accepting paths', () => {
  const source = {
    providerSessionId: 'thread-abc',
    cliSource: { workspaceId: 'folder', paneKey: 'tab:leaf' }
  }
  expect(RUNTIME_CAPABILITIES).toContain(STRUCTURED_AGENT_SESSION_CLI_SOURCE_RUNTIME_CAPABILITY)
  expect(ResumeSource.parse(source)).toEqual(source)
  expect(ResumeSource.safeParse({ ...source, transcriptPath: '/client/path' }).success).toBe(false)
  expect(
    ResumeSource.safeParse({
      ...source,
      cliSource: { ...source.cliSource, accountHome: '/client/home' }
    }).success
  ).toBe(false)
  const first = createParams({ resumeFrom: source })
  expect(first.envelope.payloadFingerprint).not.toBe(
    createParams({ resumeFrom: RESUME }).envelope.payloadFingerprint
  )
  expect(first.envelope.payloadFingerprint).toBe(
    createParams({ resumeFrom: source }).envelope.payloadFingerprint
  )
  expect(first.envelope.payloadFingerprint).not.toBe(
    createParams({
      resumeFrom: {
        ...source,
        cliSource: { ...source.cliSource, paneKey: 'other:leaf' }
      }
    }).envelope.payloadFingerprint
  )
})
