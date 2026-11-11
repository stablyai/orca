import { expect, it } from 'vitest'
import { agentPickerEntryOptions } from './agent-launch-picker-catalog'
import type { AgentPickerEntry } from './agent-launch-picker'

it('uses listed Claude alias efforts for a saved resolved model', () => {
  const entry: AgentPickerEntry = {
    agent: 'claude',
    label: 'Claude',
    rows: [],
    surfaces: ['terminal', 'chat'],
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
  const options = agentPickerEntryOptions(entry, 'claude-opus-5-5', 'terminal')
  expect(options.find(({ id }) => id === 'effort')?.kind).toMatchObject({
    choices: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }]
  })
})
