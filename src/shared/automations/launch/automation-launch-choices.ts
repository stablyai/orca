import type {
  AutomationLaunchSetup,
  AutomationLaunchPreferences,
  AutomationLaunchSetupPatch
} from './automation-launch-types'
import type {
  AgentChoicePatch,
  AgentDedicatedChoices
} from '../../agent-launch/choices/agent-launch-choices'
import { reconcileAgentChoiceArgsDetailed } from '../../agent-launch/choices/agent-choice-reconciliation'
import { getAgentSessionOptionLaunchCatalog } from '../../agent-session/options/agent-session-option-catalog'
import { projectAgentLaunchInputViews } from '../../agent-launch/choices/agent-launch-profile'
import type { TuiAgent } from '../../agent-launch/catalog/tui-agent'

export function automationLaunchChoices(setup: AutomationLaunchSetup): AgentDedicatedChoices {
  const preferences = setup.launchPreferences
  return {
    ...(preferences?.model ? { model: preferences.model } : {}),
    ...(preferences?.permissionMode ? { permissionMode: preferences.permissionMode } : {}),
    options: Object.fromEntries(
      Object.entries(preferences?.options ?? {}).filter(
        (entry): entry is [string, string] => entry[1] !== null
      )
    )
  }
}

export function automationArgumentChoices(
  agent: TuiAgent,
  source: string,
  choices: AgentDedicatedChoices = {}
) {
  const catalog = getAgentSessionOptionLaunchCatalog(agent)
  return reconcileAgentChoiceArgsDetailed({
    agent,
    userArgs: source,
    choices,
    mode: 'load',
    keys: new Set([
      'model',
      'permissionMode',
      ...Object.keys(choices.options ?? {}),
      ...(catalog?.unknownModelOptions ?? []).map((option) => option.id),
      ...(catalog?.models.flatMap((model) => model.options.map((option) => option.id)) ?? [])
    ])
  })
}

export function automationLaunchInputs(agent: TuiAgent, setup: AutomationLaunchSetup) {
  const choices = automationLaunchChoices(setup)
  const result = automationArgumentChoices(agent, setup.agentArgs ?? '', choices)
  const views = projectAgentLaunchInputViews(
    agent,
    choices,
    result,
    setup.agentArgs !== undefined ? { agentArgs: setup.agentArgs } : {}
  )
  const chatSessionOptions = { ...views.sessionOptions, ...views.chatSessionOptions }
  return {
    ...views,
    ...(setup.launchPreferences !== undefined || setup.agentArgs !== undefined
      ? { sessionOptions: views.sessionOptions ?? {}, chatSessionOptions }
      : {})
  }
}

export function patchAutomationChoices(
  agent: TuiAgent,
  setup: AutomationLaunchSetup,
  patch: AgentChoicePatch
): AutomationLaunchSetup {
  const choices = automationLaunchChoices(setup)
  const keys = new Set([
    ...(patch.model !== undefined ? ['model'] : []),
    ...(patch.permissionMode !== undefined ? ['permissionMode'] : []),
    ...Object.keys(patch.options ?? {})
  ])
  const edit = (source: string) => {
    const current = automationArgumentChoices(agent, source, choices)
    return reconcileAgentChoiceArgsDetailed({
      agent,
      userArgs: source,
      choices: {
        ...current.sourceChoices,
        ...choices,
        options: { ...current.sourceChoices.options, ...choices.options }
      },
      mode: 'choice-edit',
      keys,
      patch,
      sourceEdit: true
    })
  }

  const accepted = edit(setup.agentArgs ?? '')
  const effects = accepted.effects
  const preferences: AutomationLaunchPreferences = {
    ...setup.launchPreferences,
    options: { ...setup.launchPreferences?.options, ...effects.options }
  }
  if (effects.model !== undefined) {
    preferences.model = effects.model
  }
  if (effects.permissionMode === 'default') {
    delete preferences.permissionMode
  } else if (effects.permissionMode !== undefined) {
    preferences.permissionMode = effects.permissionMode
  }
  if (!Object.keys(preferences.options ?? {}).length) {
    delete preferences.options
  }
  return {
    ...setup,
    launchPreferences: preferences,
    ...(setup.agentArgs !== undefined ? { agentArgs: accepted.userArgs || null } : {}),
    ...(setup.extraAgentArgs !== undefined
      ? { extraAgentArgs: edit(setup.extraAgentArgs).userArgs || undefined }
      : {})
  }
}

export function patchAutomationArguments(
  agent: TuiAgent,
  setup: AutomationLaunchSetup,
  argument: Exclude<NonNullable<AutomationLaunchSetupPatch['arguments']>, { kind: 'legacy-extras' }>
): AutomationLaunchSetup {
  setup = { ...setup }
  delete setup.extraAgentArgs
  if (argument.kind === 'inherit') {
    delete setup.agentArgs
  } else {
    setup.agentArgs = argument.kind === 'empty' ? null : argument.value || null
    const source = automationArgumentChoices(agent, setup.agentArgs ?? '')
    const accepted = reconcileAgentChoiceArgsDetailed({
      agent,
      userArgs: setup.agentArgs ?? '',
      choices: automationLaunchChoices(setup),
      mode: 'arguments-edit',
      keys: new Set(source.recognized.map((entry) => entry.key))
    })
    const preferences = {
      ...setup.launchPreferences,
      options: { ...setup.launchPreferences?.options }
    }
    for (const [key, value] of Object.entries(accepted.effects.options ?? {})) {
      if (value === null) {
        preferences.options[key] = null
      }
    }
    for (const occurrence of accepted.recognized) {
      if (occurrence.key === 'model') {
        delete preferences.model
      } else if (occurrence.key === 'permissionMode') {
        delete preferences.permissionMode
      } else {
        delete preferences.options[occurrence.key]
      }
    }
    if (setup.launchPreferences !== undefined) {
      const { options, ...rest } = preferences
      setup.launchPreferences = Object.keys(options).length ? preferences : rest
    }
  }
  return setup
}
