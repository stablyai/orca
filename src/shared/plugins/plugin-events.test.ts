import { describe, expect, it } from 'vitest'
import { agentStatusChangedPayloadSchema } from './plugin-events'

const base = {
  worktreeId: 'repo::/Users/a/project',
  paneKey: '8f2a-4b1c:9de1-77af',
  state: 'done',
  receivedAt: 1_700_000_000_000
}

describe('agent.status.changed sessionId projection', () => {
  it('accepts a provider session id and projects it through', () => {
    const parsed = agentStatusChangedPayloadSchema.parse({ ...base, sessionId: 'sess-abc-123' })
    expect(parsed.sessionId).toBe('sess-abc-123')
  })

  it('accepts null when the pane has no provider session yet', () => {
    expect(agentStatusChangedPayloadSchema.parse({ ...base, sessionId: null }).sessionId).toBeNull()
  })

  it('stays backward compatible: existing emitters omit the field entirely', () => {
    const parsed = agentStatusChangedPayloadSchema.parse(base)
    expect(parsed.sessionId).toBeUndefined()
    expect(parsed.paneKey).toBe(base.paneKey)
  })

  it('still strips anything not in the projection', () => {
    // The point of the projection is that unknown fields do not reach plugins.
    const parsed = agentStatusChangedPayloadSchema.parse({
      ...base,
      sessionId: 'sess-1',
      transcriptPath: '/Users/a/.claude/projects/x/y.jsonl',
      prompt: 'something private'
    } as never)
    expect(parsed).not.toHaveProperty('transcriptPath')
    expect(parsed).not.toHaveProperty('prompt')
  })

  it('rejects a non-string session id', () => {
    expect(() =>
      agentStatusChangedPayloadSchema.parse({ ...base, sessionId: 42 } as never)
    ).toThrow()
  })

  it('rejects an empty session id, so "" cannot masquerade as an identity', () => {
    expect(() => agentStatusChangedPayloadSchema.parse({ ...base, sessionId: '' })).toThrow()
  })
})
