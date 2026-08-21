import { describe, expect, it } from 'vitest'
import { agentStatusChangedPayloadSchema } from './plugin-events'

describe('agent.status.changed payload schema', () => {
  const base = {
    worktreeId: 'repo-1::/repo',
    paneKey: 'tab-1:11111111-1111-4111-8111-111111111111',
    state: 'working',
    receivedAt: Date.now()
  }

  it('accepts the historical four-field payload (backwards compatibility)', () => {
    const parsed = agentStatusChangedPayloadSchema.safeParse(base)
    expect(parsed.success).toBe(true)
  })

  it('accepts session identifiers so plugins can tell agents apart (#15639)', () => {
    const parsed = agentStatusChangedPayloadSchema.safeParse({
      ...base,
      sessionId: 'session-A',
      transcriptPath: '/transcripts/session-A.jsonl'
    })
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.sessionId).toBe('session-A')
      expect(parsed.data.transcriptPath).toBe('/transcripts/session-A.jsonl')
    }
  })

  it('keeps the fields optional for agents that report no session', () => {
    const parsed = agentStatusChangedPayloadSchema.safeParse(base)
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.sessionId).toBeUndefined()
      expect(parsed.data.transcriptPath).toBeUndefined()
    }
  })

  it('rejects empty session identifiers rather than emitting ambiguous blanks', () => {
    const parsed = agentStatusChangedPayloadSchema.safeParse({
      ...base,
      sessionId: ''
    })
    expect(parsed.success).toBe(false)
  })
})
