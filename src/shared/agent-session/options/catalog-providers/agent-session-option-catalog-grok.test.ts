import { describe, expect, it } from 'vitest'
import { mergeDiscoveredAuthoritativeModels } from '../agent-session-option-catalog'
import type { CatalogModel } from './agent-session-option-catalog-types'
import { GROK_SESSION_OPTION_CATALOG } from './agent-session-option-catalog-grok'
import { resolveAgentSessionOptionLaunch } from '../launch/agent-session-option-launch'
import '../../../native-chat/input/session-options/native-chat-session-option-commands'

describe('grok agent-arg overrides', () => {
  it('drops only the overridden key from the launch record and argv', () => {
    expect(
      resolveAgentSessionOptionLaunch('grok', { model: 'grok-4.5', effort: 'high' }, [
        '--reasoning-effort=low'
      ])
    ).toEqual({
      args: ['-m', 'grok-4.5'],
      appliedValues: { model: 'grok-4.5' }
    })
  })

  it('cascades a model override onto the effort entry', () => {
    // User -m overrides can change the effort menu, invalidating the picker's evidence.
    expect(
      resolveAgentSessionOptionLaunch('grok', { model: 'grok-4.5', effort: 'high' }, [
        '-m',
        'grok-build'
      ]).appliedValues
    ).toEqual({})
  })
})

describe('mergeDiscoveredAuthoritativeModels', () => {
  const seed = GROK_SESSION_OPTION_CATALOG.models
  const discovered = (...ids: string[]): CatalogModel[] =>
    ids.map((id) => ({ id, label: id, options: [] }))

  it('gives a matched seed row its own menu, not the default row’s', () => {
    const multiSeed: CatalogModel[] = [
      { id: 'grok-4.6', label: 'Grok 4.6', isDefault: true, options: seed[0].options },
      { id: 'grok-lite', label: 'Grok Lite', options: [] }
    ]
    const merged = mergeDiscoveredAuthoritativeModels(multiSeed, discovered('grok-lite'))
    expect(merged.map(({ id }) => id)).toEqual(['grok-lite'])
    expect(merged[0].options).toEqual([])
  })

  it('adds discovered models absent from the seed, lending them the default’s options', () => {
    // Unseeded models inherit the default row menu; seeded siblings keep their own narrower advertised menus.
    const merged = mergeDiscoveredAuthoritativeModels(seed, discovered('grok-4.5', 'grok-build'))
    expect(merged.map(({ id }) => id)).toEqual(['grok-4.5', 'grok-build'])
  })
})
