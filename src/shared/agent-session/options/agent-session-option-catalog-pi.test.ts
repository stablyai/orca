import { describe, expect, it } from 'vitest'
import {
  getAgentSessionOptionCatalog,
  getAgentSessionOptionLaunchCatalog
} from './agent-session-option-catalog'
import { sourceControlActionOptions } from '../../source-control/ai/recipes/source-control-action-options'
import {
  removeOverriddenAgentSessionArgs,
  resolveAgentSessionOptionLaunch
} from './agent-session-option-launch'

describe('Pi launch options', () => {
  it('registers the catalog so the launcher can offer its options at launch', () => {
    const catalog = getAgentSessionOptionCatalog('pi')
    expect(catalog).not.toBeNull()
    expect(getAgentSessionOptionLaunchCatalog('pi')).toBe(catalog)
    // Nothing is seeded from a model list, so the picker keeps Pi's own discovered models.
    expect(catalog?.models).toEqual([])
  })

  it('offers the thinking level to the launcher with the flag a terminal launch applies', () => {
    expect(sourceControlActionOptions('pi', 'anthropic/claude-sonnet-4-5')).toMatchObject([
      { route: null, option: { id: 'effort', apply: { launchArgs: expect.any(Function) } } }
    ])
  })

  it('maps the model to --model and the effort to --thinking', () => {
    expect(
      resolveAgentSessionOptionLaunch('pi', {
        model: 'anthropic/claude-sonnet-4-5',
        effort: 'xhigh'
      })
    ).toEqual({
      args: ['--model', 'anthropic/claude-sonnet-4-5', '--thinking', 'xhigh'],
      appliedValues: { model: 'anthropic/claude-sonnet-4-5', effort: 'xhigh' }
    })
  })

  it('applies a thinking level without a model so Pi keeps its configured model', () => {
    expect(resolveAgentSessionOptionLaunch('pi', { effort: 'low' })).toEqual({
      args: ['--thinking', 'low'],
      appliedValues: { effort: 'low' }
    })
  })

  it('sends nothing when no model or effort was picked', () => {
    expect(resolveAgentSessionOptionLaunch('pi', {})).toEqual({ args: [], appliedValues: {} })
    expect(resolveAgentSessionOptionLaunch('pi', undefined)).toEqual({
      args: [],
      appliedValues: {}
    })
  })

  it('replaces configured --model and --thinking arguments in either spelling', () => {
    expect(
      removeOverriddenAgentSessionArgs(
        'pi',
        { model: 'anthropic/claude-sonnet-4-5', effort: 'low' },
        ['--model', 'anthropic/opus', '--thinking=high', '--no-extensions']
      )
    ).toEqual(['--no-extensions'])
  })

  it('drops a configured --provider with the model it pinned', () => {
    expect(
      removeOverriddenAgentSessionArgs('pi', { model: 'anthropic/claude-sonnet-4-5' }, [
        '--provider',
        'openai',
        '--model',
        'gpt-5.5',
        '--no-extensions'
      ])
    ).toEqual(['--no-extensions'])
  })

  it('keeps a configured --provider when the launch only picks a thinking level', () => {
    expect(
      removeOverriddenAgentSessionArgs('pi', { effort: 'low' }, [
        '--provider',
        'openai',
        '--model',
        'gpt-5.5'
      ])
    ).toEqual(['--provider', 'openai', '--model', 'gpt-5.5'])
  })

  it('clears a configured -m model flag so the launch keeps one model', () => {
    expect(
      removeOverriddenAgentSessionArgs('pi', { model: 'anthropic/claude-sonnet-4-5' }, [
        '-m',
        'anthropic/opus',
        '--thinking=high'
      ])
    ).toEqual(['--thinking=high'])
    expect(
      removeOverriddenAgentSessionArgs('pi', { model: 'anthropic/claude-sonnet-4-5' }, [
        '-m=anthropic/opus'
      ])
    ).toEqual([])
  })
})
