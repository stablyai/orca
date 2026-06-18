import {
  SOURCE_CONTROL_TEXT_ACTION_IDS,
  setSourceControlActionDefault,
  type SourceControlActionId,
  type SourceControlTextActionId
} from '../../../../shared/source-control-ai-actions'
import type { SourceControlAiSettings } from '../../../../shared/source-control-ai-types'
import type { ActionRecipeDraftValue } from './source-control-ai-action-recipe-draft'

const TEXT_ACTION_IDS = new Set<string>(SOURCE_CONTROL_TEXT_ACTION_IDS)

function isTextActionId(actionId: SourceControlActionId): actionId is SourceControlTextActionId {
  return TEXT_ACTION_IDS.has(actionId)
}

/**
 * Build the settings patch that persists an action recipe's command template and
 * CLI arguments. For text recipes it also clears the legacy per-operation
 * instruction.
 *
 * Why: `normalizeSourceControlAiSettings` re-injects `instructionsByOperation`
 * (and the projected legacy `commitMessageAi.customPrompt`) into the command
 * template whenever the saved template equals the default `{basePrompt}`. Without
 * retiring that legacy instruction here, reducing a template back to the default
 * silently springs back to the old instruction on the next read.
 */
export function buildActionRecipeSavePatch(
  current: Pick<SourceControlAiSettings, 'actions' | 'instructionsByOperation'>,
  actionId: SourceControlActionId,
  value: ActionRecipeDraftValue
): Partial<SourceControlAiSettings> {
  const actions = setSourceControlActionDefault(current.actions, actionId, {
    commandInputTemplate: value.commandInputTemplate,
    agentArgs: value.agentArgs
  })
  if (!isTextActionId(actionId)) {
    return { actions }
  }
  return {
    actions,
    instructionsByOperation: {
      ...current.instructionsByOperation,
      [actionId]: ''
    }
  }
}
