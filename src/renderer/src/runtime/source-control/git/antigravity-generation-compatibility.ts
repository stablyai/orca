import { ANTIGRAVITY_CONFIGURED_MODEL_RUNTIME_CAPABILITY } from '../../../../../shared/source-control/runtime/source-control-runtime-capabilities'
import { hasFlag } from '../../../../../shared/agent-session/options/agent-cli-flag-detection'
import { planCommitMessageGeneration } from '../../../../../shared/source-control/ai/generation/commit-message-plan'
import { resolveSourceControlAiForOperation } from '../../../../../shared/source-control/ai/source-control-ai-operation-resolution'
import {
  getRuntimeCommitMessageSettings,
  type RuntimeGitContext,
  type RuntimeGenerateCommitMessageOverrides
} from './runtime-git-client-context'
import { runtimeEnvironmentSupportsCapability } from '../../rpc/compatibility/runtime-capability-proof'

export async function antigravityGenerationCompatibilityError(
  environmentId: string,
  context: RuntimeGitContext,
  operation: 'commitMessage' | 'pullRequest',
  overrides?: RuntimeGenerateCommitMessageOverrides
): Promise<string | null> {
  let params = overrides?.sourceControlAiResolvedParams
  if (!params) {
    const settings = getRuntimeCommitMessageSettings(
      context.target,
      context.prefs,
      context.connectionId
    )
    const resolved = resolveSourceControlAiForOperation({
      settings: {
        ...settings,
        defaultTuiAgent: context.prefs?.defaultTuiAgent ?? null,
        sourceControlAi: overrides?.sourceControlAi ?? settings.sourceControlAi,
        agentCmdOverrides: overrides?.agentCmdOverrides ?? settings.agentCmdOverrides ?? {}
      },
      operation,
      discoveryHostKey: settings.commitMessageDiscoveryHostKey
    })
    if (resolved.ok) {
      params = resolved.value.params
    }
  }
  if (params?.agentId !== 'antigravity' || params.model !== 'default') {
    return null
  }
  const planned = planCommitMessageGeneration(params, '')
  // A recipe or command override can already supply a model that older planners understand.
  if (planned.ok && hasFlag(planned.plan.args, ['--model'])) {
    return null
  }
  if (
    await runtimeEnvironmentSupportsCapability(
      environmentId,
      ANTIGRAVITY_CONFIGURED_MODEL_RUNTIME_CAPABILITY
    )
  ) {
    return null
  }
  return 'This remote Orca server does not support Antigravity’s configured model. Update the remote server or select an explicit Antigravity model.'
}
