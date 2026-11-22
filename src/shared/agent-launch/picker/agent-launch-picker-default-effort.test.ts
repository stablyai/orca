import { expect, it } from 'vitest'
import {
  agentPickerDraft,
  agentPickerLaunchInputs,
  type AgentPickerEntry
} from './agent-launch-picker'
import { agentPickerEntryOptions } from './agent-launch-picker-catalog'
import { applyAgentPickerEdit } from './agent-launch-picker-edits'
import { TEXT_ACTION_DEFAULT_MODEL } from './agent-launch-picker-text-action'

const entry: AgentPickerEntry = {
  agent: 'claude',
  label: 'Claude',
  rows: [{ kind: 'terminal', agent: 'claude' }],
  surfaces: ['terminal'],
  defaultSurface: 'terminal',
  terminal: {},
  structured: {},
  catalog: { origin: 'unknown' }
}

it('launches with no effort once the Default level replaces a picked one', () => {
  const picked = applyAgentPickerEdit(
    entry,
    { ...agentPickerDraft(entry), arguments: '--effort high --add-dir docs' },
    { kind: 'choice', patch: { model: 'opus', options: { effort: 'max' } } }
  )
  const cleared = applyAgentPickerEdit(entry, picked, {
    kind: 'choice',
    patch: { options: { effort: TEXT_ACTION_DEFAULT_MODEL } }
  })
  expect(agentPickerLaunchInputs(cleared, entry)).toEqual({
    agentArgs: '--add-dir docs',
    sessionOptions: { model: 'opus' }
  })
})

it('carries an unconfirmed Kiro effort only into Chat and can delegate it back to Kiro', () => {
  const kiro: AgentPickerEntry = {
    ...entry,
    agent: 'kiro',
    surfaces: ['terminal', 'chat'],
    catalog: {
      origin: 'probe',
      fetchedAt: 1,
      models: [{ id: 'opus', label: 'Opus', isDefault: false, efforts: [], effortsKnown: false }]
    }
  }
  const options = agentPickerEntryOptions(kiro, 'opus', 'chat')
  const effort = options.find((option) => option.id === 'effort')?.kind
  expect(effort?.type === 'select' && effort.choices.map((choice) => choice.value)).toEqual([
    'low',
    'medium',
    'high',
    'xhigh',
    'max'
  ])
  const picked = applyAgentPickerEdit(kiro, agentPickerDraft(kiro), {
    kind: 'choice',
    patch: { model: 'opus', options: { effort: 'high' } }
  })
  expect(agentPickerLaunchInputs(picked, kiro)).toMatchObject({
    sessionOptions: { model: 'opus' },
    chatSessionOptions: { model: 'opus', effort: 'high' }
  })
  expect(agentPickerLaunchInputs(picked, kiro).sessionOptions).not.toHaveProperty('effort')
  const cleared = applyAgentPickerEdit(kiro, picked, {
    kind: 'choice',
    patch: { options: { effort: TEXT_ACTION_DEFAULT_MODEL } }
  })
  expect(agentPickerLaunchInputs(cleared, kiro)).toEqual({ sessionOptions: { model: 'opus' } })
})
