import { automationLegacyArguments } from '../../../../shared/automation-launch-setup-source'
import {
  automationCanonicalLaunchSetup,
  hasModernAutomationLaunchSetup
} from '../../../../shared/automation-launch-setup'
import {
  foldAutomationSourceEdit,
  type AutomationLaunchEdit
} from '../../../../shared/automation-launch-source-edits'
import { parseExtraAgentArgs } from '../../../../shared/automation-extra-agent-args'
import type { AgentPickerDraft } from '../../../../shared/agent-launch-picker'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { AutomationDraft } from './AutomationEditorDialog'

export function editsSupplementalArguments(draft: AutomationDraft, modern: boolean): boolean {
  const input = draft.launchArgumentsInput
  return (
    modern &&
    !(
      input?.kind === 'legacy' &&
      !parseExtraAgentArgs({ agent: draft.agentId, extraAgentArgs: input.value }).ok
    )
  )
}

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
  let patch: AutomationLaunchEdit = { ...current.launchSetupPatch }
  if (rebound) {
    const extraAgentArgs = editsSupplementalArguments(current, modern)
      ? current.extraAgentArgs
      : current.launchArgumentsInput?.kind === 'legacy'
        ? current.launchArgumentsInput.value
        : automationLegacyArguments(current.agentId, current)
    setup = { surface: pickedSurface ?? surface, ...(extraAgentArgs ? { extraAgentArgs } : {}) }
    patch =
      modern || hasModernAutomationLaunchSetup(current) || current.launchSetupPatch?.copy
        ? { copy: setup }
        : { arguments: { kind: 'legacy-extras', value: extraAgentArgs ?? '' } }
  }
  if (pickedSurface) {
    setup = { ...setup, surface: pickedSurface }
    patch.surface = pickedSurface
  }
  if (edits?.arguments !== undefined) {
    const folded = foldAutomationSourceEdit(agentId, setup, patch, {
      kind: 'arguments',
      value:
        edits.arguments === null ? { kind: 'empty' } : { kind: 'value', value: edits.arguments }
    })
    setup = folded.setup
    patch = folded.patch
  }
  if (choicesChanged) {
    const folded = foldAutomationSourceEdit(agentId, setup, patch, {
      kind: 'choices',
      value: choices
    })
    setup = folded.setup
    patch = folded.patch
  }
  const raw = current.launchArgumentsInput
  const keepRaw =
    !rebound &&
    raw &&
    edits?.arguments === undefined &&
    (!choicesChanged || !parseExtraAgentArgs({ agent: agentId, extraAgentArgs: raw.value }).ok)
  return {
    ...current,
    ...setup,
    agentId,
    extraAgentArgs: setup.extraAgentArgs ?? '',
    launchPreferences: setup.launchPreferences,
    agentArgs: setup.agentArgs,
    launchSetupPatch: patch,
    launchArgumentsInput: keepRaw ? raw : undefined
  }
}

export function editAutomationLegacyDraft(
  current: AutomationDraft,
  value: string,
  modern: boolean
): AutomationDraft {
  const kind = modern ? 'supplemental' : 'legacy'
  const { setup, patch } = foldAutomationSourceEdit(
    current.agentId,
    automationCanonicalLaunchSetup(current),
    current.launchSetupPatch,
    { kind, value }
  )
  return {
    ...current,
    ...setup,
    extraAgentArgs: setup.extraAgentArgs ?? '',
    launchPreferences: setup.launchPreferences,
    agentArgs: setup.agentArgs,
    launchSetupPatch: patch,
    launchArgumentsInput: { kind, value }
  }
}
