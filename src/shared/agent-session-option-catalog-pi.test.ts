import { describe, expect, it } from 'vitest'
import { getAgentSessionOptionCatalog } from './agent-session-option-catalog'
import {
  removeOverriddenAgentSessionArgs,
  resolveAgentSessionOptionLaunch
} from './agent-session-option-launch'

describe('Pi launch options', () => {
  it('does not expose worker-only launch options as an interactive session catalog', () => {
    expect(getAgentSessionOptionCatalog('pi')).toBeNull()
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
