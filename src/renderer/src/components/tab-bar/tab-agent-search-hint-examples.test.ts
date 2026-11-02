import { expect, it } from 'vitest'
import type { AgentPickerEntry, AgentPickerModel } from '../../../../shared/agent-launch-picker'
import { searchAgentPickerSetups } from '../../../../shared/agent-launch-picker-search'
import { getTabAgentSearchHintExamples } from './tab-agent-search-hint-examples'

function geminiEntry(models: AgentPickerModel[]): AgentPickerEntry {
  return {
    agent: 'gemini',
    label: 'Gemini',
    rows: [{ agent: 'gemini', kind: 'cli' }],
    surfaces: ['terminal'],
    defaultSurface: 'terminal',
    terminal: {},
    structured: {},
    catalog: { origin: 'probe', fetchedAt: 1, models }
  }
}

const pro: AgentPickerModel = {
  id: 'gemini-3.1-pro',
  label: 'Gemini 3.1 Pro',
  isDefault: true,
  efforts: []
}

it('offers the available default model and produces a launchable query for a Gemini-only install', () => {
  const entry = geminiEntry([
    { ...pro, id: 'old', label: 'Old', isLegacy: true },
    { ...pro, id: 'hidden', label: 'Hidden', hidden: true },
    { ...pro, id: 'flash', label: 'Flash', isDefault: false },
    pro
  ])
  const examples = getTabAgentSearchHintExamples([entry])
  expect(examples).toEqual(['Gemini 3.1 Pro'])
  expect(searchAgentPickerSetups([entry], examples[0])[0]?.choices.model).toBe(pro.id)
})

it('uses the model id when its display label only matches the agent name', () => {
  const entry = geminiEntry([{ ...pro, label: 'Gemini' }])
  const examples = getTabAgentSearchHintExamples([entry])
  expect(examples).toEqual([pro.id])
  expect(searchAgentPickerSetups([entry], examples[0])[0]?.choices.model).toBe(pro.id)
})

it('falls back to the id when a competing model wins the display label query', () => {
  const model = { ...pro, id: 'gemini-3.1-flash', label: 'Gemini 3.1' }
  const entry = geminiEntry([{ ...pro, isDefault: false }, model])
  expect(searchAgentPickerSetups([entry], model.label)[0]?.choices.model).toBe(pro.id)
  const examples = getTabAgentSearchHintExamples([entry])
  expect(examples).toEqual([model.id])
  expect(searchAgentPickerSetups([entry], examples[0])[0]?.choices.model).toBe(model.id)
})

it('omits a model when both its label and id select a competing model', () => {
  const model = { ...pro, id: 'gemini-3.1', label: 'Gemini 3.1' }
  const entry = geminiEntry([{ ...pro, isDefault: false }, model])
  expect(searchAgentPickerSetups([entry], model.label)[0]?.choices.model).toBe(pro.id)
  expect(searchAgentPickerSetups([entry], model.id)[0]?.choices.model).toBe(pro.id)
  expect(getTabAgentSearchHintExamples([entry])).toEqual([])
})

it('validates the selected agent across the full picker even when model ids coincide', () => {
  const competitor: AgentPickerEntry = {
    ...geminiEntry([
      { ...pro, id: 'gpt-6.1-terra', label: 'Terra' },
      { ...pro, isDefault: false }
    ]),
    agent: 'codex',
    label: 'Codex',
    rows: [{ agent: 'codex', kind: 'cli' }]
  }
  const entries = [competitor, geminiEntry([pro])]
  expect(searchAgentPickerSetups(entries, pro.label)[0]?.entry.agent).toBe('codex')
  expect(getTabAgentSearchHintExamples(entries)).toEqual(['Terra'])
})

it('skips unknown, unavailable, hidden and legacy catalogs instead of inventing examples', () => {
  const entry = geminiEntry([pro])
  expect(
    getTabAgentSearchHintExamples([
      { ...entry, catalog: { origin: 'unknown' } },
      { ...entry, surfaces: [] },
      geminiEntry([{ ...pro, hidden: true }]),
      geminiEntry([{ ...pro, isLegacy: true }]),
      geminiEntry([])
    ])
  ).toEqual([])
})
