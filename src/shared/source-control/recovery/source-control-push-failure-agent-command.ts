import { buildSourceControlRecoveryAgentCommandInput } from './source-control-recovery-agent-command'

export function buildPushFailureAgentCommandInput({
  promptOverride,
  commandInputTemplate,
  basePrompt
}: {
  promptOverride?: string
  commandInputTemplate?: string | null
  basePrompt: string
}): string {
  return buildSourceControlRecoveryAgentCommandInput({
    actionId: 'fixPushFailure',
    promptOverride,
    commandInputTemplate,
    basePrompt
  })
}
