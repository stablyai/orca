import { describe, expect, it } from 'vitest'
import { getAgentModelProbeSpec } from './agent-model-probe-spec'
import { GROK_SESSION_OPTION_CATALOG } from './agent-session-option-catalog-grok'
import { getCommitMessageAgentSpec, listCommitMessageAgentIds } from './commit-message-agent-spec'

describe('getAgentModelProbeSpec', () => {
  it('resolves grok as a discovery-only probe with no static model list', () => {
    const spec = getAgentModelProbeSpec('grok')
    expect(spec).toMatchObject({
      id: 'grok',
      binary: 'grok',
      modelSource: 'dynamic',
      models: [],
      defaultModelId: 'grok-4.5'
    })
    expect(spec?.modelDiscovery).toMatchObject({ binary: 'grok', args: ['models'] })
  })

  it('wires that probe to the parser that reads a real listing', () => {
    // Pinning binary and args alone would still pass with the wrong parser attached,
    // leaving discovery to publish nothing on every host.
    const parsed = getAgentModelProbeSpec('grok')!.modelDiscovery!.parse(
      'You are logged in with grok.com.\n\nDefault model: grok-4.5\n\nAvailable models:\n  * grok-4.5 (default)\n'
    )
    expect(parsed).toEqual([{ id: 'grok-4.5', label: 'Grok 4.5', isDefault: true }])
  })

  it('keeps the grok probe default in step with the catalog seed', () => {
    expect(getAgentModelProbeSpec('grok')!.defaultModelId).toBe(
      GROK_SESSION_OPTION_CATALOG.models[0].id
    )
  })

  it('aliases commit-message agents by identity rather than copying them', () => {
    // A lossy adapter here would silently drop fields like
    // `modelDiscovery.stdinPayload` and break Claude discovery.
    for (const id of listCommitMessageAgentIds()) {
      expect(getAgentModelProbeSpec(id)).toBe(getCommitMessageAgentSpec(id))
    }
  })

  it('keeps grok out of the commit-message registry', () => {
    expect(getCommitMessageAgentSpec('grok')).toBeUndefined()
    expect(listCommitMessageAgentIds()).not.toContain('grok')
  })

  it('is undefined for an agent in neither registry', () => {
    expect(getAgentModelProbeSpec('aider')).toBeUndefined()
  })
})
