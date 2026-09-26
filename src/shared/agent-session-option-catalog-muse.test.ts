import { describe, expect, it } from 'vitest'
import { getAgentSessionOptionCatalog } from './agent-session-option-catalog'
import { MUSE_SESSION_OPTION_CATALOG } from './agent-session-option-catalog-muse'

const effort = () => {
  const option = (MUSE_SESSION_OPTION_CATALOG.unknownModelOptions ?? []).find(
    (candidate) => candidate.id === 'effort'
  )
  if (!option) {
    throw new Error('Muse effort option missing from catalog')
  }
  return option
}

describe('muse session option catalog', () => {
  it('is registered for the muse agent', () => {
    expect(getAgentSessionOptionCatalog('muse')).toBe(MUSE_SESSION_OPTION_CATALOG)
  })

  it('switches effort mid-session through the TUI slash command', () => {
    const midSession = effort().apply.midSession
    expect(midSession?.kind).toBe('command')
    if (midSession?.kind !== 'command') {
      throw new Error('Muse effort midSession must stay a slash command')
    }
    expect(midSession.build('low')).toBe('/effort low')
  })

  it('keeps launch args for worker starts', () => {
    expect(effort().apply.launchArgs?.('ultra')).toEqual(['--reasoning-effort', 'ultra'])
  })
})
