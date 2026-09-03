import { describe, expect, it } from 'vitest'
import { toDiscoveredCatalogModels } from './discovered-agent-model-catalog'

const OPUS_1M = {
  id: 'opus[1m]',
  label: 'Opus (1M context)',
  description: 'Opus 5 with 1M context',
  thinkingLevels: [
    { id: 'low', label: 'Low' },
    { id: 'high', label: 'High' }
  ],
  supportsFastMode: true
}

describe('toDiscoveredCatalogModels', () => {
  it('keeps a probed 1M-context variant with its effort and fast-mode options', () => {
    const models = toDiscoveredCatalogModels('claude', {
      success: true,
      models: [{ id: 'opus', label: 'Opus' }, OPUS_1M],
      catalogOrigin: 'probe'
    })
    const longContext = models?.find((model) => model.id === 'opus[1m]')
    expect(longContext?.label).toBe('Opus (1M context)')
    expect(longContext?.options.map((option) => option.id)).toEqual(['effort', 'fastMode'])
    const effort = longContext?.options.find((option) => option.id === 'effort')?.kind
    expect(effort?.type === 'select' && effort.choices.map((choice) => choice.value)).toEqual([
      'low',
      'high'
    ])
  })

  it('rejects a spec fallback list for Claude', () => {
    expect(
      toDiscoveredCatalogModels('claude', {
        success: true,
        models: [OPUS_1M],
        catalogOrigin: 'spec'
      })
    ).toBeNull()
  })

  it('rejects a response from a runtime too old to report catalogOrigin', () => {
    expect(toDiscoveredCatalogModels('claude', { success: true, models: [OPUS_1M] })).toBeNull()
  })

  it('returns null for a failed or empty probe', () => {
    expect(toDiscoveredCatalogModels('claude', { success: false, error: 'boom' })).toBeNull()
    expect(
      toDiscoveredCatalogModels('claude', { success: true, models: [], catalogOrigin: 'probe' })
    ).toBeNull()
    expect(toDiscoveredCatalogModels('claude', null)).toBeNull()
  })

  it('carries the discovered default flag', () => {
    const models = toDiscoveredCatalogModels('claude', {
      success: true,
      models: [{ id: 'sonnet', label: 'Sonnet', isDefault: true }],
      catalogOrigin: 'probe'
    })
    expect(models?.[0]?.isDefault).toBe(true)
  })
})
