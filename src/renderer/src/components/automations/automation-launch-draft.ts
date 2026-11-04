import {
  automationArgumentChoices,
  automationLegacyArguments,
  patchAutomationArguments,
  patchAutomationChoices,
  patchAutomationLegacyArguments
} from '../../../../shared/automation-launch-setup-source'
import { automationCanonicalLaunchSetup } from '../../../../shared/automation-launch-setup'
import type { AgentPickerDraft } from '../../../../shared/agent-launch-picker'
import type { AutomationLaunchSetupPatch } from '../../../../shared/automations-types'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { AutomationDraft } from './AutomationEditorDialog'

export function pickAutomationLaunch(
  current: AutomationDraft,
  agentId: TuiAgent,
  accepted: AgentPickerDraft | undefined,
  pickedSurface: 'chat' | 'terminal' | undefined,
  modern: boolean,
  surface: 'chat' | 'terminal'
): AutomationDraft {
  const rebound = current.agentId !== agentId
  const edits = modern ? accepted?.acceptedEdits : undefined
  const choices = edits?.choices
  const choicesChanged =
    choices &&
    (choices.model !== undefined ||
      choices.permissionMode !== undefined ||
      Object.keys(choices.options ?? {}).length > 0)
  if (!rebound && !pickedSurface && !choicesChanged && edits?.arguments === undefined) {
    return current
  }
  let setup = automationCanonicalLaunchSetup(current)
  let patch: AutomationLaunchSetupPatch = { ...current.launchSetupPatch }
  if (rebound) {
    const extraAgentArgs = modern
      ? current.extraAgentArgs
      : current.launchSetupPatch?.arguments?.kind === 'legacy-extras'
        ? current.launchSetupPatch.arguments.value
        : automationLegacyArguments(current.agentId, current)
    setup = { surface: pickedSurface ?? surface, ...(extraAgentArgs ? { extraAgentArgs } : {}) }
    patch = modern
      ? { copy: setup }
      : { arguments: { kind: 'legacy-extras', value: extraAgentArgs ?? '' } }
  }
  if (pickedSurface) {
    setup = { ...setup, surface: pickedSurface }
    patch.surface = pickedSurface
  }
  if (edits?.arguments !== undefined) {
    patch.arguments =
      edits.arguments === null ? { kind: 'empty' } : { kind: 'value', value: edits.arguments }
    setup = patchAutomationArguments(agentId, setup, patch.arguments)
    if (patch.choices) {
      patch.choices = { ...patch.choices, options: { ...patch.choices.options } }
      for (const occurrence of automationArgumentChoices(agentId, edits.arguments ?? '')
        .recognized) {
        if (occurrence.key === 'model') {
          delete patch.choices.model
        } else if (occurrence.key === 'permissionMode') {
          delete patch.choices.permissionMode
        } else {
          delete patch.choices.options![occurrence.key]
        }
      }
    }
  }
  if (choicesChanged) {
    setup = patchAutomationChoices(agentId, setup, choices)
    patch.choices = {
      ...patch.choices,
      ...choices,
      options: { ...patch.choices?.options, ...choices.options }
    }
  }
  return {
    ...current,
    ...setup,
    agentId,
    extraAgentArgs: setup.extraAgentArgs ?? '',
    launchPreferences: setup.launchPreferences,
    agentArgs: setup.agentArgs,
    launchSetupPatch: patch
  }
}

export function editAutomationLegacyDraft(
  current: AutomationDraft,
  value: string,
  modern: boolean
): AutomationDraft {
  const canonical = automationCanonicalLaunchSetup(current)
  const represented = modern
    ? (automationLegacyArguments(current.agentId, {
        ...canonical,
        extraAgentArgs: value || undefined
      }) ?? '')
    : value
  const setup = patchAutomationLegacyArguments(current.agentId, canonical, represented)
  const patch: AutomationLaunchSetupPatch = {
    ...current.launchSetupPatch,
    arguments: { kind: 'legacy-extras', value: represented }
  }
  if (patch.choices) {
    patch.choices = { ...patch.choices, options: { ...patch.choices.options } }
    if (patch.choices.model !== undefined) {
      if (setup.launchPreferences?.model === undefined) {
        delete patch.choices.model
      } else {
        patch.choices.model = setup.launchPreferences.model
      }
    }
    if (patch.choices.options?.effort !== undefined) {
      const effort = setup.launchPreferences?.options?.effort
      if (effort === undefined) {
        delete patch.choices.options.effort
      } else {
        patch.choices.options.effort = effort
      }
    }
  }
  return {
    ...current,
    ...setup,
    extraAgentArgs: setup.extraAgentArgs ?? '',
    launchPreferences: setup.launchPreferences,
    agentArgs: setup.agentArgs,
    launchSetupPatch: patch
  }
}
