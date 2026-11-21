import { expect, it } from 'vitest'
import {
  agentPickerDraft,
  agentPickerLaunchInputs,
  type AgentPickerEntry
} from './agent-launch-picker'
import { applyAgentPickerEdit } from './agent-launch-picker-edits'
import { TEXT_ACTION_DEFAULT_MODEL } from './agent-launch-picker-text-action'

it('sends the Kiro agent only when launching Chat', () => {
  const draft = { agent: 'kiro' as const, choices: {}, kiroChatAgent: 'code-reviewer' }
  expect(agentPickerLaunchInputs({ ...draft, surface: 'chat' }).chatSessionOptions).toMatchObject({
    kiroAgentMode: 'code-reviewer'
  })
  expect(
    agentPickerLaunchInputs({ ...draft, surface: 'terminal' }).chatSessionOptions
  ).toBeUndefined()
})

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
