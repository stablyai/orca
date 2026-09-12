import { describe, expect, it } from 'vitest'
import {
  formatOrchestrationPrincipal,
  parseOrchestrationPrincipal,
  principalFromPaneKey
} from './orchestration-principal'
import { structuredAgentSessionTabId } from './structured-agent-session-tab-id'

const LEAF = '6f9e2d4a-1b3c-4d5e-8f7a-9b8c7d6e5f4a'

describe('orchestration principal', () => {
  it('round-trips both kinds through format then parse', () => {
    const pane = { kind: 'pane', paneKey: `tab_a:${LEAF}` } as const
    const session = { kind: 'session', sessionId: 'sess_123' } as const
    expect(parseOrchestrationPrincipal(formatOrchestrationPrincipal(pane))).toEqual(pane)
    expect(parseOrchestrationPrincipal(formatOrchestrationPrincipal(session))).toEqual(session)
  })

  it('keeps the payload intact past the first colon of a real pane key', () => {
    expect(parseOrchestrationPrincipal(`pane:tab_a:${LEAF}`)).toEqual({
      kind: 'pane',
      paneKey: `tab_a:${LEAF}`
    })
  })

  it('returns null for empty payload, unknown tag, no colon, and empty string', () => {
    expect(parseOrchestrationPrincipal('pane:')).toBeNull()
    expect(parseOrchestrationPrincipal('session:')).toBeNull()
    expect(parseOrchestrationPrincipal('lease:x')).toBeNull()
    expect(parseOrchestrationPrincipal('no-colon')).toBeNull()
    expect(parseOrchestrationPrincipal('')).toBeNull()
  })

  it('classifies a NULL pane key to a NULL principal', () => {
    expect(principalFromPaneKey(null)).toBeNull()
    expect(principalFromPaneKey(undefined)).toBeNull()
  })

  it('classifies an ordinary pane key to a pane principal', () => {
    expect(principalFromPaneKey(`tab_a:${LEAF}`)).toBe(`pane:tab_a:${LEAF}`)
  })

  it('classifies a structured worker pane key to its session principal', () => {
    const paneKey = `${structuredAgentSessionTabId('sess_123')}:${LEAF}`
    expect(principalFromPaneKey(paneKey)).toBe('session:sess_123')
  })

  it('classifies an unparseable pane key as a pane principal, not null', () => {
    // Legacy/free-form keys stay addressable as opaque pane identity.
    expect(principalFromPaneKey('tab_worker:leaf_worker')).toBe('pane:tab_worker:leaf_worker')
  })

  it('never derives a session principal without a real terminal leaf', () => {
    // A fabricated structured-looking key with a non-UUID leaf does not parse as a pane key, so it
    // stays a pane principal — classification never rewards a guessed session id by itself.
    const fabricated = `${structuredAgentSessionTabId('sess_123')}:anything`
    expect(principalFromPaneKey(fabricated)).toBe(`pane:${fabricated}`)
  })
})
