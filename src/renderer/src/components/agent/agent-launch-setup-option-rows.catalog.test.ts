import { expect, it } from 'vitest'
import {
  agentPickerEntryOptions,
  agentPickerModels
} from '../../../../shared/agent-launch/picker/agent-launch-picker-catalog'
import { agentPickerPanelArguments } from '../../../../shared/agent-launch/picker/agent-launch-picker-arguments'
import {
  agentPickerLaunchInputs,
  type AgentPickerDraft,
  type AgentPickerEntry
} from '../../../../shared/agent-launch/picker/agent-launch-picker'
import { agentLaunchSetupOptionRows } from './agent-launch-setup-option-rows'

it('keeps listed Claude alias capabilities for a saved resolved model through launch', () => {
  const model = 'claude-opus-5-5'
  const entry: AgentPickerEntry = {
    agent: 'claude',
    label: 'Claude',
    rows: [{ agent: 'claude', kind: 'terminal' }],
    surfaces: ['chat', 'terminal'],
    defaultSurface: 'terminal',
    terminal: {},
    structured: {},
    catalogRead: 'settled',
    coherentCatalog: true,
    catalog: {
      origin: 'probe',
      fetchedAt: 1,
      models: [
        {
          id: 'opus',
          resolvedModel: 'claude-opus-5-5',
          label: 'Opus',
          isDefault: false,
          efforts: [
            { value: 'low', label: 'Low' },
            { value: 'medium', label: 'Medium' },
            { value: 'high', label: 'High' }
          ]
        }
      ]
    }
  }
  const draft: AgentPickerDraft = {
    agent: 'claude',
    surface: 'terminal',
    choices: { model, options: { effort: 'high' } }
  }
  const options = agentPickerEntryOptions(entry, model, 'terminal')
  expect(options.find((row) => row.id === 'effort')?.kind).toMatchObject({
    choices: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }]
  })
  const rows = agentLaunchSetupOptionRows({
    entry,
    draft,
    currentModel: model,
    options,
    models: agentPickerModels(entry),
    argumentsView: agentPickerPanelArguments(entry, draft),
    argumentsKnown: true,
    defaultsPending: false,
    disabled: false
  })
  expect(rows.find((row) => row.id === 'effort')).toMatchObject({
    settable: true,
    kind: {
      currentValue: 'high',
      choices: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }]
    }
  })
  draft.choices.options = { effort: 'medium' }
  expect(agentPickerLaunchInputs(draft).sessionOptions).toMatchObject({ model, effort: 'medium' })
})
