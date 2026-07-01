import {
  DEFAULT_SOURCE_CONTROL_ACTION_COMMAND_TEMPLATES,
  renderSourceControlActionCommandTemplate
} from './source-control-ai-actions'

export function buildCommitFailureAgentCommandInput({
  promptOverride,
  commandInputTemplate,
  basePrompt,
  repoPath,
  worktreePath
}: {
  promptOverride?: string
  commandInputTemplate?: string | null
  basePrompt: string
  repoPath?: string | null
  worktreePath?: string | null
}): string {
  return (
    promptOverride ??
    renderSourceControlActionCommandTemplate(
      commandInputTemplate ?? DEFAULT_SOURCE_CONTROL_ACTION_COMMAND_TEMPLATES.fixCommitFailure,
      { basePrompt, repoPath, worktreePath }
    )
  ).trim()
}
