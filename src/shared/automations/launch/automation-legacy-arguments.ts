import type { AutomationLaunchSetup } from './automation-launch-types'
import { projectAgentLaunchProfile } from '../../agent-launch/choices/agent-launch-profile'
import {
  hasExtraAgentArgs,
  parseExtraAgentArgs
} from '../../agent-launch/startup/automation-extra-agent-args'
import type { TuiAgent } from '../../agent-launch/catalog/tui-agent'
import { automationLaunchChoices, automationArgumentChoices } from './automation-launch-choices'

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
  return patchAutomationLegacyArguments(agent, setup, value)
}

export function patchAutomationLegacyArguments(
  agent: TuiAgent,
  setup: AutomationLaunchSetup,
  value: string
): AutomationLaunchSetup {
  if (value === (automationLegacyArguments(agent, setup) ?? '')) {
    return setup
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
  const { options, ...rest } = preferences
  return {
    ...setup,
    ...(setup.launchPreferences !== undefined
      ? { launchPreferences: Object.keys(options).length ? preferences : rest }
      : {}),
    ...(setup.agentArgs !== undefined && kept !== null
      ? { agentArgs: [kept, rawIncoming].filter(Boolean).join(' ') || null }
      : {}),
    extraAgentArgs: hasExtraAgentArgs(residual ?? value) ? (residual ?? value) : undefined
  }
}
