import { describe, expect, it } from 'vitest'
import { parseStructuredAgentSessionEditRequest } from './structured-agent-session-composer'

describe('parseStructuredAgentSessionEditRequest', () => {
  it('extracts one explicit edit request without forwarding the authority command', () => {
    expect(parseStructuredAgentSessionEditRequest('/edit change src/a.ts only')).toBe(
      'change src/a.ts only'
    )
  })

  it('does not infer mutation authority from ordinary or empty text', () => {
    expect(parseStructuredAgentSessionEditRequest('change src/a.ts only')).toBeNull()
    expect(parseStructuredAgentSessionEditRequest('/edit')).toBeNull()
    expect(parseStructuredAgentSessionEditRequest('/edit   ')).toBeNull()
  })
})
