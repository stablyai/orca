import { expect, it } from 'vitest'
import { getAgentSessionOptionCatalog } from './agent-session-option-catalog'
import { resolveAgentSessionOptionLaunch } from './agent-session-option-launch'

it('uses native model selection without fabricating configured account models or effort options', () => {
  const catalog = getAgentSessionOptionCatalog('reasonix')
  expect(catalog?.models).toEqual([])
  expect(catalog?.modelApply?.midSession).toEqual({ kind: 'agent-picker', command: '/model' })
  expect(
    resolveAgentSessionOptionLaunch('reasonix', {
      model: 'configured-provider-model',
      effort: 'high'
    })
  ).toEqual({
    args: ['--model', 'configured-provider-model'],
    appliedValues: { model: 'configured-provider-model' }
  })
  expect(
    resolveAgentSessionOptionLaunch('reasonix', { model: 'picker-model' }, ['--model=custom'])
  ).toEqual({ args: ['--model', 'picker-model'], appliedValues: {} })
})
