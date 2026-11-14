import { expect, it } from 'vitest'
import { agentPickerEntryOptions } from './agent-launch-picker-catalog'
import type { AgentPickerEntry } from './agent-launch-picker'

it('keeps terminal effort discovery separate from Chat and preserves a saved pair until edited', async () => {
  const { groupAntigravityModelEfforts } =
    await import('../../agent-session/options/antigravity-model-efforts')
  const { applyAgentPickerEdit } = await import('./agent-launch-picker-edits')
  const { agentPickerDraft } = await import('./agent-launch-picker')
  const { agentPickerPanelArguments } = await import('./agent-launch-picker-arguments')
  const { agentPickerModels } = await import('./agent-launch-picker-catalog')
  const entry: AgentPickerEntry = {
    agent: 'antigravity',
    label: 'Antigravity',
    rows: [],
    surfaces: ['terminal', 'chat'],
    defaultSurface: 'terminal',
    terminal: { model: 'gemini-3.8-flash-medium', options: { effort: 'low' } },
    structured: {},
    catalog: {
      origin: 'probe',
      fetchedAt: 1,
      models: [{ id: 'chat-only', label: 'Chat', isDefault: false, efforts: [] }]
    },
    terminalCatalog: {
      origin: 'probe',
      fetchedAt: 1,
      models: groupAntigravityModelEfforts([
        { id: 'gemini-3.8-flash-low', label: 'Gemini (Low)' },
        { id: 'gemini-3.8-flash-medium', label: 'Gemini (Medium)' },
        { id: 'claude-sonnet-4-6', label: 'Sonnet' }
      ])
    }
  }
  const draft = agentPickerDraft(entry)
  expect(agentPickerModels(entry, 'chat').map(({ id }) => id)).toEqual(['chat-only'])
  expect(
    agentPickerEntryOptions(entry, 'gemini-3.8-flash-medium', 'terminal').find(
      ({ id }) => id === 'effort'
    )?.kind
  ).toMatchObject({ choices: [{ value: 'low' }, { value: 'medium' }] })
  expect(agentPickerPanelArguments(entry, draft).choices).toMatchObject({
    model: 'gemini-3.8-flash-medium',
    options: { effort: 'low' }
  })
  const changed = applyAgentPickerEdit(entry, draft, {
    kind: 'choice',
    patch: { options: { effort: 'medium' } }
  })
  expect(agentPickerPanelArguments(entry, changed).choices).toMatchObject({
    model: 'gemini-3.8-flash-medium',
    options: { effort: 'medium' }
  })
  const cleared = applyAgentPickerEdit(entry, draft, {
    kind: 'choice',
    patch: { options: { effort: '' } }
  })
  expect(agentPickerPanelArguments(entry, cleared).choices.model).toBe('gemini-3.8-flash')
  expect(agentPickerPanelArguments(entry, cleared).choices.options?.effort).toBeUndefined()
  const removed = applyAgentPickerEdit(entry, draft, { kind: 'remove-chip', key: 'effort' })
  expect(agentPickerPanelArguments(entry, removed).choices.model).toBe('gemini-3.8-flash-medium')
  expect(agentPickerPanelArguments(entry, removed).choices.options?.effort).toBeUndefined()
  const literal = applyAgentPickerEdit(entry, draft, {
    kind: 'choice',
    patch: { model: 'claude-sonnet-4-6' }
  })
  expect(agentPickerPanelArguments(entry, literal).choices.options?.effort).toBeUndefined()
})
