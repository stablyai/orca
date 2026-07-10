import {
  DEFAULT_SOURCE_CONTROL_ACTION_COMMAND_TEMPLATES,
  renderSourceControlActionCommandTemplate,
  type SourceControlLaunchActionId
} from './source-control-ai-actions'

export function buildSourceControlRecoveryAgentCommandInput({
  actionId,
  promptOverride,
  commandInputTemplate,
  basePrompt
}: {
  actionId: SourceControlLaunchActionId
  promptOverride?: string
  commandInputTemplate?: string | null
  basePrompt: string
}): string {
  return (
    promptOverride ??
    renderSourceControlActionCommandTemplate(
      commandInputTemplate ?? DEFAULT_SOURCE_CONTROL_ACTION_COMMAND_TEMPLATES[actionId],
      { basePrompt }
    )
  ).trim()
}
