import { expect, it } from 'vitest'
import {
  agentPickerDraft,
  agentPickerFreshLaunchInputs,
  agentPickerLaunchInputs,
  type AgentPickerEntry
} from './agent-launch-picker'
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

it.each([
  ['claude', '--effort high --add-dir docs', '--add-dir docs'],
  ['claude', '--effort=high --add-dir docs', '--add-dir docs'],
  ['claude', '--effort low --effort=high --add-dir docs', '--add-dir docs'],
  ['claude', '--effort high', null],
  ['claude', '--effort high -- --effort low', '-- --effort low'],
  ['codex', '-c model_reasoning_effort="high" --add-dir docs', '--add-dir docs'],
  ['codex', '--config=model_reasoning_effort="high" --add-dir docs', '--add-dir docs'],
  ['codex', '--reasoning-effort high --add-dir docs', '--add-dir docs'],
  ['muse', '--reasoning-effort=high', null],
  ['pi', '--thinking high', null],
  ['omp', '--thinking=high', null],
  ['grok', '--reasoning-effort high', null],
  ['codebuddy', '--effort high', null],
  ['antigravity', '--effort=high', null]
] as const)(
  'Default removes inherited %s effort from %s on every picker route',
  (agent, args, expected) => {
    const configured = { ...entry, agent, arguments: args }
    for (const surface of ['terminal', 'chat'] as const) {
      const draft = applyAgentPickerEdit(configured, agentPickerDraft(configured, surface), {
        kind: 'choice',
        patch: { options: { effort: TEXT_ACTION_DEFAULT_MODEL } }
      })
      expect(agentPickerLaunchInputs(draft, configured)).toEqual({ agentArgs: expected })
      expect(
        agentPickerFreshLaunchInputs(
          draft,
          { surface, executionHostId: 'runtime:effort-test' },
          configured
        )
      ).toEqual({ agentArgs: expected })
    }
  }
)
