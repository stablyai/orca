import type {
  Automation,
  AutomationLaunchSetup,
  AutomationLaunchSetupPatch
} from './automations-types'
import { AutomationLaunchSetupPatch as PatchSchema } from './rpc-contract/automation-params'
import {
  automationLaunchInputs,
  automationLegacyArguments,
  editAutomationLegacyArguments,
  patchAutomationChoices,
  patchAutomationArguments
} from './automation-launch-setup-source'
import { hasExtraAgentArgs, parseExtraAgentArgs } from './automation-extra-agent-args'
import type { TuiAgent } from './tui-agent'
import { retireAutomationChoiceSources } from './automation-launch-source-edits'

export function automationCanonicalLaunchSetup(
  automation: AutomationLaunchSetup & { launchSetup?: AutomationLaunchSetup }
): AutomationLaunchSetup {
  if (automation.launchSetup) {
    return { ...automation.launchSetup }
  }
  return {
    ...(automation.surface !== undefined ? { surface: automation.surface } : {}),
    ...(automation.extraAgentArgs !== undefined
      ? { extraAgentArgs: automation.extraAgentArgs }
      : {}),
    ...(automation.launchPreferences !== undefined
      ? { launchPreferences: automation.launchPreferences }
      : {}),
    ...(automation.agentArgs !== undefined ? { agentArgs: automation.agentArgs } : {})
  }
}

export function hasModernAutomationLaunchSetup(setup: AutomationLaunchSetup): boolean {
  return setup.launchPreferences !== undefined || setup.agentArgs !== undefined
}

export function applyAutomationLaunchSetupPatch<
  T extends {
    agentId?: TuiAgent
    extraAgentArgs?: string
    launchSetupPatch?: AutomationLaunchSetupPatch
  }
>(
  input: T,
  current?: AutomationLaunchSetup & Pick<Automation, 'agentId'>
): Omit<T, 'launchSetupPatch'> & AutomationLaunchSetup {
  const { launchSetupPatch, ...rest } = input
  if (input.extraAgentArgs !== undefined && typeof input.extraAgentArgs !== 'string') {
    throw new Error('Extra agent arguments must be text.')
  }
  const patch = launchSetupPatch === undefined ? undefined : PatchSchema.parse(launchSetupPatch)
  if (patch && input.extraAgentArgs !== undefined) {
    throw new Error('Save automation arguments through one launch setup change.')
  }
  const agent = input.agentId ?? current?.agentId
  if (!agent) {
    throw new Error('Choose an automation agent.')
  }
  const rebind = current !== undefined && agent !== current.agentId
  let setup = current ? automationCanonicalLaunchSetup(current) : {}
  if (rebind) {
    const visible = input.extraAgentArgs ?? automationLegacyArguments(current.agentId, setup)
    setup = { surface: setup.surface }
    if (
      patch?.arguments === undefined &&
      patch?.copy === undefined &&
      patch?.sources?.arguments === undefined &&
      patch?.sources?.legacyArguments === undefined &&
      patch?.sources?.extraAgentArgs === undefined &&
      hasExtraAgentArgs(visible)
    ) {
      const parsed = parseExtraAgentArgs({ agent, extraAgentArgs: visible })
      if (!parsed.ok) {
        throw new Error(parsed.error)
      }
      setup.extraAgentArgs = visible
    }
  }
  if (patch?.copy) {
    setup = { ...patch.copy }
  }
  if (patch?.surface !== undefined) {
    setup.surface = patch.surface
  }
  const legacy =
    patch?.arguments?.kind === 'legacy-extras' ? patch.arguments.value : input.extraAgentArgs
  if (legacy !== undefined) {
    // Dormant legacy Chat source keeps its existing grammar and never becomes a modern Chat pick.
    setup =
      setup.surface === 'chat' && !hasModernAutomationLaunchSetup(setup)
        ? { ...setup, extraAgentArgs: hasExtraAgentArgs(legacy) ? legacy : undefined }
        : editAutomationLegacyArguments(agent, setup, legacy)
  }
  if (patch?.arguments && patch.arguments.kind !== 'legacy-extras') {
    setup = patchAutomationArguments(agent, setup, patch.arguments)
  }
  if (patch?.sources) {
    const sources = patch.sources
    setup = retireAutomationChoiceSources(agent, setup, sources.retiredChoices ?? [])
    if (sources.legacyArguments !== undefined) {
      setup = editAutomationLegacyArguments(agent, setup, sources.legacyArguments)
    }
  }
  if (patch?.choices) {
    setup = patchAutomationChoices(agent, setup, patch.choices)
  }
  if (patch?.sources?.arguments) {
    setup = patchAutomationArguments(agent, setup, patch.sources.arguments)
  }
  if (patch?.sources?.extraAgentArgs !== undefined) {
    setup = {
      ...setup,
      extraAgentArgs: hasExtraAgentArgs(patch.sources.extraAgentArgs)
        ? patch.sources.extraAgentArgs
        : undefined
    }
  }
  return {
    ...rest,
    surface: setup.surface,
    extraAgentArgs: setup.extraAgentArgs,
    launchPreferences: setup.launchPreferences,
    agentArgs: setup.agentArgs
  }
}

export function automationWithLaunchSetup(automation: Automation): Automation {
  const launchSetup = automationCanonicalLaunchSetup(automation)
  const extraAgentArgs = automationLegacyArguments(automation.agentId, launchSetup)
  return {
    ...automationCanonicalDefinition(automation),
    ...(extraAgentArgs !== undefined ? { extraAgentArgs } : {}),
    launchSetup
  }
}

export function automationTerminalLaunchInputs(automation: Automation) {
  const setup = automationCanonicalLaunchSetup(automation)
  const { agentArgs, sessionOptions } = automationLaunchInputs(automation.agentId, setup)
  return {
    ...(agentArgs !== undefined ? { agentArgs } : {}),
    ...(sessionOptions ? { sessionOptions } : {}),
    ...(setup.extraAgentArgs ? { extraAgentArgs: setup.extraAgentArgs } : {})
  }
}

export function automationCanonicalDefinition(automation: Automation): Automation {
  const {
    launchSetup: _view,
    surface: _surface,
    extraAgentArgs: _extra,
    launchPreferences: _choices,
    agentArgs: _args,
    ...rest
  } = automation
  return { ...rest, ...automationCanonicalLaunchSetup(automation) }
}
