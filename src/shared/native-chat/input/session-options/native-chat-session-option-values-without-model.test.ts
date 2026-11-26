import { expect, it } from 'vitest'
import { getAgentSessionOptionCatalog } from '../../../agent-session/options/agent-session-option-catalog'
import type { SessionOptionValue } from '../native-chat-session-options'
import { createNativeChatPtySessionOptions } from './native-chat-pty-session-options'
import { seedNativeChatAppliedSessionOptions } from './native-chat-session-option-cache'
import {
  takeNativeChatStatusReport,
  type NativeChatStatusReportMemory
} from './native-chat-status-session-options'

function launched(
  agent: 'codex' | 'claude' | 'grok' | 'cursor',
  scopeKey: string,
  values: Record<string, SessionOptionValue>
) {
  const catalog = getAgentSessionOptionCatalog(agent)!
  const memory: NativeChatStatusReportMemory = new Map()
  const during: { dispatch?: () => void } = {}
  seedNativeChatAppliedSessionOptions(scopeKey, agent, values)
  const surface = createNativeChatPtySessionOptions({
    agent,
    scopeKey,
    mode: 'live',
    modelLabel: 'Model',
    dispatchCommand: async () => during.dispatch?.()
  })!
  const report = (model: string) => {
    const reported = takeNativeChatStatusReport(memory, scopeKey, agent, catalog, catalog.models, {
      model,
      providerSession: { id: 's' }
    })
    if (reported) {
      surface.reportSessionOptions(reported.values, reported.forNewModel)
    }
  }
  const effort = () => value('effort')
  const value = (id: string) => {
    const row = surface.getSnapshot().find((descriptor) => descriptor.id === id)
    const current =
      row?.kind.type === 'select' || row?.kind.type === 'boolean'
        ? row.kind.currentValue
        : undefined
    return [current, row?.valueSource]
  }
  return { surface, report, effort, value, during, catalog }
}

it('keeps an effort launched without a model through the first model report, where that model offers it', () => {
  const offered = launched('codex', 'without-model-offered', { effort: 'ultra' })
  expect(offered.effort()).toEqual(['ultra', 'applied'])
  offered.report('gpt-5.6-sol')
  expect(offered.effort()).toEqual(['ultra', 'applied'])

  const missing = launched('codex', 'without-model-missing', { effort: 'ultra' })
  missing.report('gpt-5.5')
  expect(missing.effort()).toEqual([undefined, 'unknown'])

  // Cursor composes effort into the model id, so a launch naming no model never ran it.
  const composed = launched('cursor', 'without-model-composed', { effort: 'high' })
  composed.report('gpt-5.3-codex')
  expect(composed.effort()).toEqual([undefined, 'unknown'])
})

it('lets a pick made before the model is known replace the launch effort and keep it after the report', async () => {
  const { surface, report, effort } = launched('claude', 'without-model-pick', { effort: 'high' })
  await surface.setOption('effort', 'low')
  expect(effort()).toEqual(['low', 'dispatched'])
  report('claude-opus-5-5')
  expect(effort()).toEqual(['low', 'dispatched'])
})

it('keeps a pick made before the model is known when the first model report lands mid-dispatch', async () => {
  const grok = launched('grok', 'without-model-pick-race', { effort: 'high' })
  grok.during.dispatch = () => grok.report(grok.catalog.models.find((model) => model.isDefault)!.id)
  await grok.surface.setOption('effort', 'low')
  expect(grok.effort()).toEqual(['low', 'dispatched'])

  const claude = launched('claude', 'without-model-flip-race', { fastMode: true })
  claude.during.dispatch = () => claude.report('claude-opus-5-5')
  await claude.surface.setOption('fastMode', false)
  expect(claude.value('fastMode')).toEqual([false, 'applied'])
})

it('keeps the launch effort when the default model the session already runs is picked again', async () => {
  const { surface, effort, catalog } = launched('grok', 'without-model-default-repick', {
    effort: 'low'
  })
  expect(effort()).toEqual(['low', 'applied'])
  await surface.setOption('model', catalog.models.find((model) => model.isDefault)!.id)
  expect(effort()).toEqual(['low', 'applied'])
})
