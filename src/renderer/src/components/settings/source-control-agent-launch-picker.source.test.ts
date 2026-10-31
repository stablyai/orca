import { entry } from './source-control-agent-picker-test-fixture'

import { agentModelChoiceChips } from './agent-model-choice-chips'

import { expect, it } from 'vitest'
import { agentPickerLaunchInputs } from '../../../../shared/agent-launch-picker'
import { getDefaultSettings } from '../../../../shared/constants'
import type { AgentPickerEntry } from '../../../../shared/agent-launch-picker'
import { applyAgentPickerEdit } from '../../../../shared/agent-launch-picker-edits'
import { captureSourceControlActionSelection } from '../../../../shared/source-control-ai-operation-policy'
import {
  canonicalSourceControlActionSelection,
  selectSourceControlActionRecipe
} from '../../../../shared/source-control-action-selection'
import { projectSourceControlActionLaunch } from '../../../../shared/source-control-action-launch-preferences'

import { agentPickerPanelArguments } from '../../../../shared/agent-launch-picker-arguments'
import { saveSourceControlActionRecipe } from '../../../../shared/source-control-ai-recipe-save'
import { resolveAgentLaunchCommand } from '../../../../shared/tui-agent-launch-command'
import {
  applySourceControlPickerDraft,
  sourceControlPickerDraft
} from './source-control-agent-launch-picker'

it.each([
  ['global', 'raw'],
  ['global', 'serialized node'],
  ['repo', 'raw'],
  ['repo', 'serialized node']
] as const)(
  'conserves a quoted model from canonical %s %s ingress through effort, Save and normal reopen',
  (scope, ingress) => {
    const text = `-c 'model="true"'`
    const base = getDefaultSettings('/tmp/picker-canonical')
    const settings = {
      ...base,
      sourceControlAi: {
        ...base.sourceControlAi!,
        actions: {
          fixChecks: {
            agentId: 'codex' as const,
            surface: 'chat' as const,
            commandInputTemplate: '{basePrompt}',
            agentArgs: ingress === 'raw' ? text : '',
            ...(ingress === 'serialized node'
              ? { argumentChoices: { syntaxAgent: 'codex' as const, nodes: [{ at: 0, text }] } }
              : {})
          }
        }
      }
    }
    const inventory: AgentPickerEntry = {
      ...entry,
      agent: 'codex',
      label: 'Codex',
      arguments: '',
      terminal: { permissionMode: 'own' },
      structured: { model: 'gpt-5.5' },
      catalog: { origin: 'unknown' }
    }
    const repo =
      scope === 'repo'
        ? {
            sourceControlAi: {
              actionOverrides: { fixChecks: settings.sourceControlAi.actions.fixChecks }
            }
          }
        : undefined
    const captured = captureSourceControlActionSelection({ actionId: 'fixChecks', settings, repo })
    expect(captured.current.argumentChoices).toBeUndefined()
    expect(captured.current.agentArgs).toBe(text)
    const draft = sourceControlPickerDraft(captured, inventory, 'chat')
    const snapshot = structuredClone(captured)
    const initialView = agentPickerPanelArguments(inventory, draft)
    expect(initialView.choices.model).toBe('true')
    expect(initialView.context.occurrences).toMatchObject([
      { key: 'model', value: 'true', valueType: 'string', lift: false }
    ])
    expect(applySourceControlPickerDraft(captured, inventory, draft)).toBe(captured)
    expect(captured).toEqual(snapshot)
    const edited = applyAgentPickerEdit(inventory, draft, {
      kind: 'choice',
      patch: { options: { effort: 'high' } }
    })
    const currentView = agentPickerPanelArguments(inventory, edited)
    expect(currentView.choices).toMatchObject({ model: 'true', options: { effort: 'high' } })
    expect(
      agentModelChoiceChips('codex', 'Codex', currentView.choices, () => '', currentView.context)
    ).toContainEqual(expect.objectContaining({ key: 'model', flag: text, source: 'arguments' }))
    expect(edited.choices.model).toBeUndefined()
    expect(captured).toEqual(snapshot)
    const selection = applySourceControlPickerDraft(captured, inventory, edited)
    const saved = saveSourceControlActionRecipe({
      target: scope === 'global' ? { type: 'global' } : { type: 'repo', repoId: 'repo-source' },
      settings,
      repo,
      actionId: 'fixChecks',
      recipe: selectSourceControlActionRecipe(selection)
    })
    const reopened = captureSourceControlActionSelection({
      actionId: 'fixChecks',
      settings:
        'sourceControlAi' in saved
          ? { ...settings, sourceControlAi: saved.sourceControlAi }
          : settings,
      repo:
        'update' in saved
          ? { sourceControlAi: saved.update.sourceControlAi ?? undefined }
          : undefined
    })
    expect(reopened.source.authoredPreferences?.modelSelection).toEqual({
      base: 'default',
      options: { effort: { agentId: 'codex', value: 'high' } }
    })
    const savedProjection = projectSourceControlActionLaunch(
      selectSourceControlActionRecipe(reopened),
      'codex',
      { basePrompt: 'fix checks' }
    )
    const chatView = agentPickerPanelArguments(
      inventory,
      sourceControlPickerDraft(reopened, inventory, 'chat')
    ).choices
    const full = agentPickerLaunchInputs({ ...edited, surface: 'terminal' }, inventory)
    const compile = (input: typeof full) =>
      resolveAgentLaunchCommand({
        agent: 'codex',
        cmdOverrides: { codex: 'cx' },
        platform: 'darwin',
        shell: 'posix',
        agentArgs: input.agentArgs,
        sessionOptions: input.sessionOptions,
        sessionOptionsOverrideAgentArgs: true
      })
    process.stdout.write(
      `${JSON.stringify({
        metric: 'canonical-quoted-ingress',
        scope,
        ingress,
        captured,
        selection,
        saved,
        reopened,
        chatView,
        savedProjection,
        full,
        savedCompiler: compile(savedProjection),
        fullCompiler: compile(full)
      })}\n`
    )
    expect(reopened.current.argumentChoices).toBeUndefined()
    expect(reopened.current.agentArgs).toBe(text)
    expect(chatView).toMatchObject({ model: 'true', options: { effort: 'high' } })
    expect(savedProjection.chatSessionOptions).toEqual({ model: 'true', effort: 'high' })
    expect(full.chatSessionOptions).toEqual({ model: 'true', effort: 'high' })
    expect(savedProjection.sessionOptions).toEqual({ effort: 'high' })
    expect(savedProjection.agentArgs).toBe(text)
    expect(full.agentArgs).toContain('model="true"')
    expect(full.sessionOptions).toEqual({ effort: 'high' })
    expect(reopened.current.agentArgs).toBe(snapshot.current.agentArgs)
    for (const model of ['true', 'gpt-5.5']) {
      const picked = applyAgentPickerEdit(inventory, edited, { kind: 'choice', patch: { model } })
      expect(agentPickerPanelArguments(inventory, picked).choices.model).toBe(model)
      expect(
        picked.recipeEdits?.selection.source.authoredPreferences?.modelSelection?.model
      ).toEqual({ agentId: 'codex', value: model })
      expect(picked.arguments).not.toContain(text)
    }
    const newer = applyAgentPickerEdit(inventory, edited, {
      kind: 'arguments',
      text: '-c model=latest --search'
    })
    const removed = applyAgentPickerEdit(inventory, newer, { kind: 'remove-chip', key: 'model' })
    const removedSelection = applySourceControlPickerDraft(captured, inventory, removed)
    expect(removed.pendingArguments).toBeUndefined()
    expect(removedSelection.source.authoredPreferences?.modelSelection?.model).toEqual({
      agentId: 'codex',
      value: null
    })
    expect(
      agentPickerPanelArguments(inventory, sourceControlPickerDraft(removedSelection, inventory))
        .choices.model
    ).toBeUndefined()
    expect(removed.arguments).not.toContain('latest')
    expect(removed.arguments).toContain('--search')
  }
)

it('distinguishes group fallback, applicable null, foreign binding and deliberate model authority on initial source', () => {
  const inventory: AgentPickerEntry = {
    ...entry,
    agent: 'codex',
    structured: { model: 'chat-default' }
  }
  for (const [binding, expected] of [
    [undefined, 'true'],
    [{ agentId: 'codex', value: null }, undefined],
    [{ agentId: 'claude', value: null }, 'true'],
    [{ agentId: 'claude', value: 'foreign-model' }, 'true'],
    [{ agentId: 'codex', value: 'gpt-5.5' }, 'gpt-5.5']
  ] as const) {
    const selection = canonicalSourceControlActionSelection({
      agentId: 'codex',
      agentArgs: `-c 'model="true"'`,
      launchPreferences: {
        agentId: 'codex',
        modelSelection: {
          base: 'default',
          ...(binding ? { model: binding } : {}),
          options: { effort: { agentId: 'codex', value: 'high' } }
        }
      }
    })
    const draft = sourceControlPickerDraft(selection, inventory)
    const view = agentPickerPanelArguments(inventory, draft)
    expect(view.choices.model).toBe(expected)
    expect(draft.delegated?.includes('model')).toBe(
      binding?.agentId === 'codex' && binding.value === null
    )
    expect(applySourceControlPickerDraft(selection, inventory, draft)).toBe(selection)
    expect(draft.arguments).toBe(`-c 'model="true"'`)
    if (binding?.agentId === 'codex' && binding.value) {
      const edited = applyAgentPickerEdit(inventory, draft, {
        kind: 'choice',
        patch: { options: { effort: 'low' } }
      })
      expect(agentPickerPanelArguments(inventory, edited).choices.model).toBe(binding.value)
      expect(
        edited.recipeEdits?.selection.source.authoredPreferences?.modelSelection?.model
      ).toEqual(binding)
    }
  }
})

it('retains a genuinely admitted saved model node through real effort editing, Save/reopen and initial/resume compilation', () => {
  const base = getDefaultSettings('/tmp/picker-admitted-node')
  const settings = {
    ...base,
    sourceControlAi: {
      ...base.sourceControlAi!,
      actions: {
        fixChecks: {
          agentId: 'codex' as const,
          agentArgs: '--search',
          argumentChoices: {
            syntaxAgent: 'codex' as const,
            nodes: [{ at: 0, text: '-m gpt-5.5' }]
          }
        }
      }
    }
  }
  const inventory: AgentPickerEntry = {
    ...entry,
    agent: 'codex',
    arguments: '',
    terminal: { permissionMode: 'own' },
    structured: {},
    catalog: { origin: 'unknown' }
  }
  const captured = captureSourceControlActionSelection({ actionId: 'fixChecks', settings })
  expect(captured.current.argumentChoices).toEqual({
    syntaxAgent: 'codex',
    nodes: [{ at: 0, text: '-m gpt-5.5' }]
  })
  const draft = sourceControlPickerDraft(captured, inventory)
  expect(agentPickerPanelArguments(inventory, draft).choices.model).toBe('gpt-5.5')
  const edited = applyAgentPickerEdit(inventory, draft, {
    kind: 'choice',
    patch: { options: { effort: 'high' } }
  })
  const selection = applySourceControlPickerDraft(captured, inventory, edited)
  const saved = saveSourceControlActionRecipe({
    target: { type: 'global' },
    settings,
    actionId: 'fixChecks',
    recipe: selectSourceControlActionRecipe(selection)
  })
  if (!('sourceControlAi' in saved)) {
    throw new Error('Expected global writer')
  }
  const reopened = captureSourceControlActionSelection({
    actionId: 'fixChecks',
    settings: { ...settings, sourceControlAi: saved.sourceControlAi }
  })
  expect(reopened.current.argumentChoices).toEqual(captured.current.argumentChoices)
  const projection = projectSourceControlActionLaunch(
    selectSourceControlActionRecipe(reopened),
    'codex',
    { basePrompt: 'Fix checks' }
  )
  expect(projection.sessionOptions).toEqual({ model: 'gpt-5.5', effort: 'high' })
  expect(projection.agentArgs).toBe('--search')
  const compiled = resolveAgentLaunchCommand({
    agent: 'codex',
    cmdOverrides: {},
    platform: 'linux',
    shell: 'posix',
    agentArgs: projection.agentArgs,
    sessionOptions: projection.sessionOptions,
    sessionOptionsOverrideAgentArgs: true
  })
  expect(compiled).toMatchObject({
    ok: true,
    command:
      "codex '-c' 'disable_paste_burst=true' '--search' '-m' 'gpt-5.5' '-c' 'model_reasoning_effort=high'",
    appliedSessionOptions: { model: 'gpt-5.5', effort: 'high' }
  })
  if (!compiled.ok) {
    throw new Error(compiled.error)
  }
  expect(compiled.resumeLaunch).toEqual({ agentCommand: "codex '--search'" })
})

it.each([
  [
    'codex',
    '-m gpt-5.5',
    { effort: 'future_effort' },
    [
      'codex',
      '-c',
      'disable_paste_burst=true',
      '-m',
      'gpt-5.5',
      '-c',
      'model_reasoning_effort=future_effort'
    ],
    { effort: 'future_effort' }
  ],
  [
    'codex',
    '-m future-model',
    { effort: 'high' },
    [
      'codex',
      '-c',
      'disable_paste_burst=true',
      '-m',
      'future-model',
      '-c',
      'model_reasoning_effort=high'
    ],
    { effort: 'high' }
  ],
  [
    'cursor',
    '--model gpt-5.3-codex',
    { effort: 'low', fastMode: 'true' },
    ['cursor-agent', '--model', 'gpt-5.3-codex-low-fast'],
    { model: 'gpt-5.3-codex', effort: 'low', fastMode: 'true' }
  ],
  [
    'cursor',
    '--model claude-opus-4-8',
    { effort: 'medium', thinking: 'true' },
    ['cursor-agent', '--model', 'claude-opus-4-8-thinking-medium'],
    { model: 'claude-opus-4-8', effort: 'medium', thinking: 'true' }
  ]
] as const)(
  'compiles current %s model context and deliberate dependent options without losing initial/resume intent',
  async (agent, raw, options, expected, baseOptions) => {
    const { tokenizeStartupCommand } = await import('../../../../shared/tui-agent-startup-shell')
    const inventory: AgentPickerEntry = {
      ...entry,
      agent,
      arguments: raw,
      terminal: { permissionMode: 'own' },
      structured: {},
      catalog: { origin: 'unknown' }
    }
    let draft = sourceControlPickerDraft(
      canonicalSourceControlActionSelection({ agentId: agent, agentArgs: raw }),
      inventory
    )
    for (const [key, value] of Object.entries(options)) {
      draft = applyAgentPickerEdit(inventory, draft, {
        kind: 'choice',
        patch: { options: { [key]: value } }
      })
    }
    const projection = agentPickerLaunchInputs(draft, inventory)
    expect(projection.sessionOptions).toEqual(baseOptions)
    const compiled = resolveAgentLaunchCommand({
      agent,
      cmdOverrides: {},
      platform: 'linux',
      shell: 'posix',
      agentArgs: projection.agentArgs,
      sessionOptions: projection.sessionOptions,
      sessionOptionsOverrideAgentArgs: true
    })
    if (!compiled.ok) {
      throw new Error(compiled.error)
    }
    expect(tokenizeStartupCommand(compiled.command, 'posix')).toMatchObject({
      ok: true,
      tokens: expected
    })
    const { buildAgentResumeStartupPlan } = await import('../../../../shared/tui-agent-startup')
    const resumed = buildAgentResumeStartupPlan({
      agent,
      cmdOverrides: {},
      platform: 'linux',
      shell: 'posix',
      ...compiled.resumeLaunch,
      providerSession: {
        key: agent === 'cursor' ? 'conversation_id' : 'session_id',
        id: 'provider-recorded-session'
      }
    })
    expect(resumed).not.toBeNull()
    const resumeTokens = tokenizeStartupCommand(resumed!.launchCommand, 'posix')
    if (!resumeTokens.ok) {
      throw new Error(resumeTokens.error)
    }
    expect(resumeTokens.tokens).toContain('provider-recorded-session')
    expect(resumeTokens.tokens).not.toContain('model_reasoning_effort=future_effort')
    expect(resumeTokens.tokens).not.toContain('model_reasoning_effort=high')
    if (agent === 'codex') {
      expect(resumeTokens.tokens.filter((token) => token === '-m')).toHaveLength(1)
      expect(resumeTokens.tokens).toContain(raw.split(' ')[1])
    } else {
      expect(resumeTokens.tokens.filter((token) => token === '--model')).toHaveLength(0)
    }
    process.stdout.write(
      `${JSON.stringify({ metric: 'dependent-initial-provider-resume', agent, raw, options, projection, compiled, resumed })}\n`
    )
  }
)
