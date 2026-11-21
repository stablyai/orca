import { describe, expect, it } from 'vitest'
import { resolveAgentSessionOptionLaunch } from '../launch/agent-session-option-launch'
import { getAgentSessionOptionCatalog } from '../agent-session-option-catalog'
import { structuredAgentSessionOptionCatalog } from '../model-catalog/structured-agent-session-discovered-model'
import { sourceControlActionOptions } from '../../../source-control/ai/recipes/source-control-action-options'
import { analyzeAgentChoiceArgs } from '../../../agent-launch/choices/agent-choice-args'

function settingsJson(args: readonly string[]): unknown {
  const index = args.indexOf('--settings')
  return index === -1 ? undefined : JSON.parse(args[index + 1])
}

describe('Claude renderer option', () => {
  it('launches the picked renderer for one session', () => {
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

  it('survives a --model in the user arguments, which still drops the model options', () => {
    const { args } = resolveAgentSessionOptionLaunch(
      'claude',
      { model: 'opus', effort: 'low', renderer: 'default' },
      ['--model', 'sonnet']
    )
    expect(args).not.toContain('--effort')
    expect(settingsJson(args)).toEqual({ tui: 'default' })
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

  it('reads both keys back out of that shared --settings', () => {
    const analysis = analyzeAgentChoiceArgs(
      'claude',
      `--settings '{"fastMode":true,"tui":"fullscreen","x":1}' --verbose`
    )
    expect(analysis.cut(analysis.occurrences)).toBe(`--settings '{"x":1}' --verbose`)
  })

  it('reaches terminal launches of a listed model', () => {
    const row = sourceControlActionOptions('claude', 'sonnet').find(
      ({ option }) => option.id === 'renderer'
    )
    expect(row?.route).toBe('terminals')
  })

  it('is not offered to a structured chat running an unlisted model', () => {
    const catalog = structuredAgentSessionOptionCatalog(
      getAgentSessionOptionCatalog('claude')!,
      { models: [], current: { model: 'claude-custom' } },
      'claude'
    )
    const unlisted = catalog.models.find(({ id }) => id === 'claude-custom')
    expect(unlisted?.options.map(({ id }) => id)).toEqual(['effort', 'fastMode'])
  })
})
