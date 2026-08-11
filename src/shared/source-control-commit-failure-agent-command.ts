import { buildSourceControlRecoveryAgentCommandInput } from './source-control-recovery-agent-command'

export function buildCommitFailureAgentCommandInput({
  promptOverride,
  commandInputTemplate,
  basePrompt
}: {
  promptOverride?: string
  commandInputTemplate?: string | null
  basePrompt: string
}): string {
  return buildSourceControlRecoveryAgentCommandInput({
    actionId: 'fixCommitFailure',
    promptOverride,
    commandInputTemplate,
    basePrompt
  })
}
