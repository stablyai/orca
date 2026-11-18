import { expect, it } from 'vitest'
import {
  agentPickerDraft,
  agentPickerLaunchInputs,
  type AgentPickerEntry
} from './agent-launch-picker'
import { applyAgentPickerEdit } from './agent-launch-picker-edits'
import { TEXT_ACTION_DEFAULT_MODEL } from './agent-launch-picker-text-action'
import {
  canonicalSourceControlActionSelection,
  selectSourceControlActionRecipe
} from '../../source-control/ai/recipes/source-control-action-selection'
import { sourceControlActionLaunchOptions } from '../../source-control/ai/recipes/source-control-action-launch-preferences'

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
    omitEffort: true,
    agentArgs: '--add-dir docs',
    sessionOptions: { model: 'opus' }
  })
})

it('publishes one effort-free Arguments value for a combined permission and Default edit', () => {
  const changed = applyAgentPickerEdit(
    entry,
    { ...agentPickerDraft(entry), arguments: '--effort high --add-dir docs' },
    {
      kind: 'choice',
      patch: { permissionMode: 'full-access', options: { effort: TEXT_ACTION_DEFAULT_MODEL } }
    }
  )
  expect(agentPickerLaunchInputs(changed, entry)).toEqual({
    omitEffort: true,
    agentArgs: '--dangerously-skip-permissions --add-dir docs',
    sessionOptions: { permissionMode: 'full-access' }
  })
})

it.each(['--effort high', '--effort high --effort low'])(
  'newly authored effort replaces Default: %s',
  (text) => {
    const cleared = applyAgentPickerEdit(entry, agentPickerDraft(entry), {
      kind: 'choice',
      patch: { options: { effort: TEXT_ACTION_DEFAULT_MODEL } }
    })
    const typing = applyAgentPickerEdit(entry, cleared, { kind: 'arguments', text })
    const accepted = applyAgentPickerEdit(entry, typing, { kind: 'accept-arguments' })
    expect(agentPickerLaunchInputs(accepted, entry).omitEffort).toBeUndefined()
    expect(accepted.acceptedEdits?.arguments).toBe(text)
    expect(accepted.acceptedEdits?.choices.options?.effort).toBeUndefined()
  }
)

it('keeps newly authored duplicate effort after saving and reloading an action', () => {
  const selected = {
    ...agentPickerDraft(entry),
    recipeEdits: {
      selection: canonicalSourceControlActionSelection({
        agentId: 'claude',
        agentArgs: '--add-dir docs'
      }),
      changed: false,
      argumentsAuthored: false
    }
  }
  const cleared = applyAgentPickerEdit(entry, selected, {
    kind: 'choice',
    patch: { options: { effort: TEXT_ACTION_DEFAULT_MODEL } }
  })
  const typing = applyAgentPickerEdit(entry, cleared, {
    kind: 'arguments',
    text: '--effort high --effort low --add-dir docs'
  })
  const accepted = applyAgentPickerEdit(entry, typing, { kind: 'accept-arguments' })
  const saved = JSON.parse(JSON.stringify(accepted.recipeEdits!.selection))
  const recipe = selectSourceControlActionRecipe(saved)
  expect(sourceControlActionLaunchOptions(recipe, 'claude').omitEffort).toBeUndefined()
  expect(recipe.agentArgs).toBe('--effort high --effort low --add-dir docs')
})
