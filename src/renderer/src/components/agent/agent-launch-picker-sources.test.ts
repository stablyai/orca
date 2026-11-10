import { expect, it } from 'vitest'
import { sourceEntry } from './agent-launch-picker-sources.test-fixture'
import {
  agentPickerEntryOptions,
  agentPickerModelMenu,
  agentPickerModels
} from '../../../../shared/agent-launch/picker/agent-launch-picker-catalog'
import {
  agentPickerDraft,
  agentPickerEffectiveChoices,
  agentPickerFreshLaunchInputs
} from '../../../../shared/agent-launch/picker/agent-launch-picker'
import { applyAgentPickerEdit } from '../../../../shared/agent-launch/picker/agent-launch-picker-edits'
import { searchAgentPickerSetups } from '../../../../shared/agent-launch/picker/agent-launch-picker-search'
import { projectAgentLaunchProfile } from '../../../../shared/agent-launch/choices/agent-launch-profile'
import { toAgentLaunchPreferences } from '../../../../shared/agent-launch/choices/agent-launch-preferences'

import type { AgentDedicatedChoices } from '../../../../shared/agent-launch/choices/agent-launch-choices'

it('selects protocol rows, efforts, defaults and search by the actual draft surface', () => {
  for (const defaultSurface of ['chat', 'terminal'] as const) {
    const entry = sourceEntry(defaultSurface)
    expect(agentPickerModels(entry, 'terminal').map(({ id }) => id)).toEqual([
      'gemini-3.8-flash-high',
      'gemini-3.8-flash-medium',
      'gemini-3.8-flash-low',
      'claude-sonnet-4-6'
    ])
    expect(agentPickerModels(entry, 'chat')[0].id).toBe('gemini-3.8-flash')
    expect(
      agentPickerEntryOptions(entry, 'gemini-3.8-flash', 'chat').find(({ id }) => id === 'effort')
        ?.kind
    ).toMatchObject({ choices: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }] })
    expect(agentPickerEntryOptions(entry, 'gemini-3.8-flash-low', 'terminal')).toEqual([])
    expect(agentPickerModels(entry, 'terminal').some(({ isDefault }) => isDefault)).toBe(false)
    const setup = searchAgentPickerSetups([entry], 'Flash Low', 8, () => 'terminal')[0]
    expect(setup).toMatchObject({ surface: 'terminal', choices: { model: 'gemini-3.8-flash-low' } })
    expect(setup.choices.options?.effort).toBeUndefined()
    expect(searchAgentPickerSetups([entry], 'Flash Low', 8, () => 'chat')[0]).toMatchObject({
      surface: 'chat',
      choices: { model: 'gemini-3.8-flash', options: { effort: 'low' } }
    })
    const pending = {
      ...entry,
      sourceCatalogs: {
        cli: {
          catalog: { origin: 'unknown' as const },
          catalogRead: 'pending' as const,
          coherentCatalog: true
        }
      }
    }
    expect(agentPickerModelMenu(pending, 'terminal').status).toBe('listing')
    expect(agentPickerModelMenu(pending, 'chat').status).toBe('listed')
  }
})

it.each([
  {},
  { model: 'gemini-3.8-flash', options: { effort: 'high' } },
  { options: { effort: 'high' } }
] satisfies AgentDedicatedChoices[])(
  'replaces model-dependent menu effort only on an explicit CLI model pick: %j',
  (terminal) => {
    const entry = { ...sourceEntry(), terminal }
    const untouched = agentPickerEffectiveChoices(entry, agentPickerDraft(entry, 'terminal'))
    expect(untouched.options?.effort).toBe(terminal.options?.effort)
    const draft = applyAgentPickerEdit(entry, agentPickerDraft(entry, 'terminal'), {
      kind: 'choice',
      patch: { model: 'gemini-3.8-flash-low' }
    })
    expect(draft.acceptedEdits?.choices).toMatchObject({
      model: 'gemini-3.8-flash-low',
      options: { effort: null }
    })
    const input = agentPickerFreshLaunchInputs(
      draft,
      { surface: 'terminal', executionHostId: 'runtime:paired' },
      entry
    )
    expect(input.sessionOptions).toEqual({ model: 'gemini-3.8-flash-low' })
    expect(toAgentLaunchPreferences(input.sessionOptions, 'antigravity')).toEqual({
      model: 'gemini-3.8-flash-low'
    })
    expect(
      projectAgentLaunchProfile(
        'antigravity',
        { agentLaunchChoices: { antigravity: terminal } },
        { target: 'terminal', choices: draft.choices, userArgs: '' }
      ).args
    ).toBe('--model gemini-3.8-flash-low')
    // Alternate launch sends the same explicit choice; it does not translate protocols.
    expect(
      agentPickerFreshLaunchInputs(
        { ...draft, surface: 'chat' },
        { surface: 'chat', executionHostId: 'local' },
        entry
      ).sessionOptions
    ).toEqual({ model: 'gemini-3.8-flash-low' })
  }
)
