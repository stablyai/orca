import { describe, expect, it } from 'vitest'
import { PI_SESSION_OPTION_CATALOG } from './agent-session-option-catalog-pi'
import {
  getAgentSessionOptionCatalog,
  getAgentSessionOptionLaunchCatalog
} from './agent-session-option-catalog'
import {
  removeOverriddenAgentSessionArgs,
  resolveAgentSessionOptionLaunch
} from './agent-session-option-launch'

const MODEL = 'anthropic/claude-sonnet-5'

describe('Pi launch options', () => {
  it('registers the catalog for worker-start and launch validation', () => {
    expect(getAgentSessionOptionCatalog('pi')).toBe(PI_SESSION_OPTION_CATALOG)
    expect(getAgentSessionOptionLaunchCatalog('pi')).toBe(PI_SESSION_OPTION_CATALOG)
    expect(PI_SESSION_OPTION_CATALOG.supportsWorkerLaunchPreferences).toBe(true)
  })

  it('passes a provider/id model through --model', () => {
    expect(resolveAgentSessionOptionLaunch('pi', { model: MODEL }, [], false)).toEqual({
      args: ['--model', MODEL],
      appliedValues: { model: MODEL }
    })
  })

  it('maps effort onto --thinking with Pi’s own level names', () => {
    expect(
      resolveAgentSessionOptionLaunch('pi', { model: MODEL, effort: 'xhigh' }, [], false)
    ).toEqual({
      args: ['--model', MODEL, '--thinking', 'xhigh'],
      appliedValues: { model: MODEL, effort: 'xhigh' }
    })
  })

  it('keeps the :thinking suffix the CLI documents as part of the model', () => {
    expect(
      resolveAgentSessionOptionLaunch('pi', { model: `${MODEL}:high` }, [], false).appliedValues
    ).toEqual({ model: `${MODEL}:high` })
  })

  it('drops an effort level Pi cannot run instead of launching with it', () => {
    expect(
      resolveAgentSessionOptionLaunch('pi', { model: MODEL, effort: 'ultra' }, [], false)
        .appliedValues
    ).toEqual({ model: MODEL })
  })

  it('removes the raw --model and --thinking a caller wrote before the terminator', () => {
    expect(
      removeOverriddenAgentSessionArgs('pi', { model: 'new/model', effort: 'high' }, [
        '--model',
        'old/model',
        '--thinking',
        'low',
        '--',
        '--model',
        'trailing'
      ])
    ).toEqual(['--', '--model', 'trailing'])
  })
})
