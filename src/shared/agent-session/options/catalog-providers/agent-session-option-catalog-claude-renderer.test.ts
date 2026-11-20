import { describe, expect, it } from 'vitest'
import { resolveAgentSessionOptionLaunch } from '../launch/agent-session-option-launch'
import { createClaudeCatalogOptions } from './agent-session-option-catalog-claude-codex'
import { getAgentSessionOptionCatalog } from '../agent-session-option-catalog'
import { sourceControlActionOptions } from '../../../source-control/ai/recipes/source-control-action-options'

function settingsJson(args: readonly string[]): unknown {
  const index = args.indexOf('--settings')
  return index === -1 ? undefined : JSON.parse(args[index + 1])
}

describe('Claude renderer option', () => {
  it('launches the inline renderer for one session', () => {
    const { args } = resolveAgentSessionOptionLaunch('claude', {
      model: 'sonnet',
      renderer: 'default'
    })
    expect(settingsJson(args)).toEqual({ tui: 'default' })
  })

  it('launches the fullscreen renderer for one session', () => {
    const { args } = resolveAgentSessionOptionLaunch('claude', {
      model: 'sonnet',
      renderer: 'fullscreen'
    })
    expect(settingsJson(args)).toEqual({ tui: 'fullscreen' })
  })

  it("sends nothing when unset, so the user's own tui setting applies", () => {
    const { args } = resolveAgentSessionOptionLaunch('claude', { model: 'sonnet' })
    expect(args).not.toContain('--settings')
  })

  it('merges with Fast mode into a single --settings', () => {
    const { args } = resolveAgentSessionOptionLaunch('claude', {
      model: 'opus',
      fastMode: true,
      renderer: 'default'
    })
    expect(args.filter((token) => token === '--settings')).toHaveLength(1)
    expect(settingsJson(args)).toEqual({ fastMode: true, tui: 'default' })
  })

  it('is offered for every built-in Claude model and unknown models', () => {
    const catalog = getAgentSessionOptionCatalog('claude')!
    for (const model of catalog.models) {
      expect(model.options.map(({ id }) => id)).toContain('renderer')
    }
    expect(catalog.unknownModelOptions?.map(({ id }) => id)).toContain('renderer')
  })

  it('is left out of option lists built for structured chats', () => {
    expect(createClaudeCatalogOptions({ effortLevelIds: ['high'] }).map(({ id }) => id)).toEqual([
      'effort'
    ])
  })

  it('reaches terminal launches only, since chats have no terminal renderer', () => {
    const row = sourceControlActionOptions('claude', 'sonnet').find(
      ({ option }) => option.id === 'renderer'
    )
    expect(row?.route).toBe('terminals')
  })

  it('shows without a picked model, unlike model-dependent mode options', () => {
    const renderer = getAgentSessionOptionCatalog('claude')!.unknownModelOptions?.find(
      ({ id }) => id === 'renderer'
    )
    expect(renderer?.category).toBeUndefined()
  })
})
