import { describe, expect, it } from 'vitest'
import { resolveDraftAgentId } from './automation-draft-model'

describe('resolveDraftAgentId', () => {
  it('keeps a supported agent', () => {
    expect(resolveDraftAgentId('claude', 'codex')).toBe('claude')
  })

  it('falls back to the default for a cleared agent', () => {
    expect(resolveDraftAgentId(null, 'codex')).toBe('codex')
    expect(resolveDraftAgentId(undefined, 'codex')).toBe('codex')
  })

  it('falls back to the default for a retired agent id from a mixed-version host', () => {
    expect(resolveDraftAgentId('gemini', 'codex')).toBe('codex')
  })
})
