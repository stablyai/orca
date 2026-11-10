import { expect, it } from 'vitest'
import type { AgentPickerRetainedSetup } from '../../../../shared/agent-launch/picker/agent-launch-picker-authority'
import type { AgentPickerEntry } from '../../../../shared/agent-launch/picker/agent-launch-picker'
import { retireAgentPickerSetups } from './agent-launch-picker-retirement'

const entry: AgentPickerEntry = {
  agent: 'codex',
  label: 'Codex',
  rows: [{ agent: 'codex', kind: 'cli' }],
  surfaces: ['terminal'],
  defaultSurface: 'terminal',
  terminal: {},
  structured: {},
  catalog: {
    origin: 'probe',
    fetchedAt: 1,
    models: [{ id: 'saved', label: 'Saved', isDefault: false, efforts: [] }]
  }
}

it('preserves edited presets until a completed catalog confirms their model or effort was removed', () => {
  const setups = new Map<string, AgentPickerRetainedSetup>([
    [
      'missing-model',
      {
        target: undefined,
        agent: 'codex',
        preset: { model: 'fresh' },
        source: undefined,
        draft: {
          agent: 'codex',
          surface: 'terminal',
          choices: { model: 'saved' },
          arguments: '--add-dir model-edits'
        },
        active: false
      }
    ],
    [
      'missing-effort',
      {
        target: undefined,
        agent: 'codex',
        preset: { model: 'saved', effort: 'high' },
        source: undefined,
        draft: {
          agent: 'codex',
          surface: 'terminal',
          choices: { model: 'saved', options: { effort: 'low' } },
          arguments: '--add-dir effort-edits'
        },
        active: false
      }
    ]
  ])
  for (const catalogRead of ['pending', 'failed', 'unsupported'] as const) {
    retireAgentPickerSetups([{ ...entry, catalogRead }], setups, undefined, 'select')
    expect([...setups.values()].map(({ draft }) => draft.arguments)).toEqual([
      '--add-dir model-edits',
      '--add-dir effort-edits'
    ])
  }

  retireAgentPickerSetups(
    [
      {
        ...entry,
        catalogRead: 'settled',
        catalog: {
          origin: 'probe',
          fetchedAt: 2,
          models: [
            { id: 'fresh', label: 'Fresh', isDefault: false, efforts: [] },
            {
              id: 'saved',
              label: 'Saved',
              isDefault: false,
              efforts: [{ value: 'high', label: 'High' }]
            }
          ]
        }
      }
    ],
    setups,
    undefined,
    'select'
  )
  expect([...setups.values()].map(({ draft }) => draft.arguments)).toEqual([
    '--add-dir model-edits',
    '--add-dir effort-edits'
  ])

  retireAgentPickerSetups([{ ...entry, catalogRead: 'settled' }], setups, undefined, 'select')
  expect([...setups.keys()]).toEqual([])
})
