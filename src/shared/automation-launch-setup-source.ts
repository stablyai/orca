import type { AutomationLaunchSetup, AutomationLaunchPreferences } from './automations-types'
import type { AgentChoicePatch, AgentDedicatedChoices } from './agent-launch-choices'
import { reconcileAgentChoiceArgsDetailed } from './agent-choice-reconciliation'
import { getAgentSessionOptionLaunchCatalog } from './agent-session/options/agent-session-option-catalog'
import { projectAgentLaunchInputViews, projectAgentLaunchProfile } from './agent-launch-profile'
import { hasExtraAgentArgs, parseExtraAgentArgs } from './automation-extra-agent-args'
import type { TuiAgent } from './tui-agent'

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

/** The old protocol sees only safely representable authored domains, never host defaults. */
export function automationLegacyArguments(
  agent: TuiAgent,
  setup: AutomationLaunchSetup
): string | undefined {
  if (setup.launchPreferences === undefined && setup.agentArgs === undefined) {
    return setup.extraAgentArgs
  }
  const choices = automationLaunchChoices(setup)
  const source = automationArgumentChoices(agent, setup.agentArgs ?? '', choices)
  const safe = source.recognized.filter((entry) => source.analysis.cut([entry]) !== null)
  const representable = {
    model: choices.model ?? safe.find((entry) => entry.key === 'model')?.value,
    options: {
      effort: choices.options?.effort ?? safe.find((entry) => entry.key === 'effort')?.value
    }
  }
  const options = Object.fromEntries(
    Object.entries(representable.options).filter(
      (entry): entry is [string, string] => entry[1] !== undefined
    )
  )
  const generated = projectAgentLaunchProfile(agent, undefined, {
    target: 'terminal',
    userArgs: '',
    choices: { ...representable, options, permissionMode: 'own' }
  }).args
  const parsed = parseExtraAgentArgs({ agent, extraAgentArgs: generated })
  const extras = [parsed.ok ? generated : '', setup.extraAgentArgs].filter(Boolean).join(' ')
  return extras || undefined
}

/** An old edit can replace its published spans, but cannot acquire authority over hidden input. */
export function editAutomationLegacyArguments(
  agent: TuiAgent,
  setup: AutomationLaunchSetup,
  value: string
): AutomationLaunchSetup {
  if (value === (automationLegacyArguments(agent, setup) ?? '')) {
    return setup
  }
  if (hasExtraAgentArgs(value)) {
    const parsed = parseExtraAgentArgs({ agent, extraAgentArgs: value })
    if (!parsed.ok) {
      throw new Error(parsed.error)
    }
  }
  const incoming = automationArgumentChoices(agent, value)
  const current = automationArgumentChoices(agent, setup.agentArgs ?? '')
  const preferences = {
    ...setup.launchPreferences,
    options: { ...setup.launchPreferences?.options }
  }
  const raw = current.recognized.filter((entry) => ['model', 'effort'].includes(entry.key))
  const routed = new Set<string>()
  for (const key of ['model', 'effort']) {
    const next = incoming.recognized.find((entry) => entry.key === key)?.value
    const owns =
      key === 'model'
        ? typeof preferences.model === 'string'
        : typeof preferences.options.effort === 'string'
    if (owns) {
      routed.add(key)
      if (key === 'model') {
        if (next === undefined) {
          delete preferences.model
        } else {
          preferences.model = next
        }
      } else {
        if (next === undefined) {
          delete preferences.options.effort
        } else {
          preferences.options.effort = next
        }
      }
    } else if (raw.some((entry) => entry.key === key)) {
      routed.add(key)
    }
  }
  const transferred = incoming.recognized.filter((entry) => routed.has(entry.key))
  const residual = incoming.analysis.cut(transferred)
  const kept = current.analysis.cut(raw.filter((entry) => routed.has(entry.key)))
  const rawIncoming = transferred
    .filter((entry) => raw.some((prior) => prior.key === entry.key))
    .map((entry) => value.slice(entry.start, entry.end))
    .join(' ')
  return {
    ...setup,
    ...(setup.launchPreferences !== undefined ? { launchPreferences: preferences } : {}),
    ...(setup.agentArgs !== undefined && kept !== null
      ? { agentArgs: [kept, rawIncoming].filter(Boolean).join(' ') || null }
      : {}),
    extraAgentArgs: hasExtraAgentArgs(residual ?? value) ? (residual ?? value) : undefined
  }
}
