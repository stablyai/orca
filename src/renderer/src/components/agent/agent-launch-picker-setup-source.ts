import { shallow } from 'zustand/shallow'
import { sameSourceControlSetupSelection } from '../../lib/source-control/ai/source-control-agent-launch-picker'
import type { AgentPickerDraft } from '../../../../shared/agent-launch/picker/agent-launch-picker'

/** Whether a retained setup still derives from the form's current draft for its agent. */
export function sameAgentPickerSetupSource(before?: AgentPickerDraft, after?: AgentPickerDraft) {
  if (before === after) {
    return true
  }
  if (!before || !after || before.agent !== after.agent) {
    return false
  }
  const a = before.recipeEdits?.selection
  const b = after.recipeEdits?.selection
  if (a && b) {
    return sameSourceControlSetupSelection(
      { ...a, current: { ...a.current, surface: b.current.surface } },
      b
    )
  }
  return (
    !a &&
    !b &&
    before.arguments === after.arguments &&
    before.choices.model === after.choices.model &&
    before.choices.permissionMode === after.choices.permissionMode &&
    shallow(before.choices.options, after.choices.options) &&
    shallow(before.delegated, after.delegated)
  )
}
