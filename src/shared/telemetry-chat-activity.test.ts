import { describe, expect, it } from 'vitest'
import { nativeChatMessageSentSchema } from './telemetry-native-feature-event-schemas'
import { agentStartedSchema } from './telemetry-app-event-schemas'

describe('versioned Chat activity telemetry', () => {
  const send = {
    agent_kind: 'codex',
    runtime: 'remote',
    semantics_version: 2,
    action: 'message',
    backend: 'structured',
    outcome: 'unconfirmed'
  }
  it('accepts historical payloads without inferring a successful outcome', () => {
    expect(
      nativeChatMessageSentSchema.parse({ agent_kind: 'codex', runtime: 'local' })
    ).not.toHaveProperty('outcome')
    expect(nativeChatMessageSentSchema.safeParse(send).success).toBe(true)
  })
  it.each([
    { prompt: 'private' },
    { path: '/private' },
    { command: '/private' },
    { outcome: 'delivered' }
  ])('rejects raw or unsupported delivery fields %j', (fields) => {
    expect(nativeChatMessageSentSchema.safeParse({ ...send, ...fields }).success).toBe(false)
  })
  it('validates structured starts with bounded attribution and rejects raw identity', () => {
    const start = {
      agent_kind: 'codex',
      launch_source: 'unknown',
      request_kind: 'resume',
      semantics_version: 2,
      backend: 'structured'
    }
    expect(agentStartedSchema.safeParse(start).success).toBe(true)
    expect(agentStartedSchema.safeParse({ ...start, session_id: 'private' }).success).toBe(false)
  })
})
