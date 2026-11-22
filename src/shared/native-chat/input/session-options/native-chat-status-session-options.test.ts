import { expect, it } from 'vitest'
import { getAgentSessionOptionCatalog } from '../../../agent-session/options/agent-session-option-catalog'
import { readNativeChatStatusSessionOptions } from './native-chat-status-session-options'

const claude = getAgentSessionOptionCatalog('claude')!

it('reports the live Claude effort with the model when that model offers it', () => {
  const report = readNativeChatStatusSessionOptions('claude', claude, claude.models, {
    model: 'claude-opus-5-5',
    providerSession: { id: 'session-a', effort: 'low' }
  })
  expect(report?.values).toEqual({ model: 'opus', effort: 'low' })
})

it('drops an effort the reported model does not offer', () => {
  const models = [{ id: 'claude-plain-1', label: 'Plain 1', options: [] }]
  const report = readNativeChatStatusSessionOptions('claude', { ...claude, models }, models, {
    model: 'claude-plain-1',
    providerSession: { id: 'session-a', effort: 'max' }
  })
  expect(report?.values).toEqual({ model: 'claude-plain-1' })
})

it('names a restarted session as a new report, even on the same model and effort', () => {
  const status = { model: 'claude-opus-5-5', providerSession: { id: 'session-a', effort: 'low' } }
  const first = readNativeChatStatusSessionOptions('claude', claude, claude.models, status)
  const repeat = readNativeChatStatusSessionOptions('claude', claude, claude.models, status)
  const restarted = readNativeChatStatusSessionOptions('claude', claude, claude.models, {
    ...status,
    providerSession: { id: 'session-b', effort: 'low' }
  })
  expect(repeat?.identity).toBe(first?.identity)
  expect(restarted?.identity).not.toBe(first?.identity)
})
