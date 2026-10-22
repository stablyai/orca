import type {
  CommitMessageAgentCapability,
  CommitMessageModelCapability
} from '../../../shared/commit-message-agent-spec'
import { getCommitMessageModelDiscoveryHostKeyForScope } from '../../../shared/commit-message-host-key'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import type { HostedReviewProvider } from '../../../shared/hosted-review'
import type { ResolvedSourceControlAiGenerationParams } from '../../../shared/source-control-ai'
import { splitWorktreeIdForFilesystem } from '../../../shared/worktree/id'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'

export type RuntimeGenerateCommitMessageResult =
  | { success: true; message: string; agentLabel?: string }
  | { success: false; error: string; canceled?: boolean }

export type RuntimeGeneratePullRequestFieldsResult =
  | {
      success: true
      fields: { base: string; title: string; body: string; draft: boolean }
      agentLabel?: string
      branchChangedByPreparation?: boolean
    }
  | { success: false; error: string; canceled?: boolean; branchChangedByPreparation?: boolean }

export type RuntimePullRequestGenerationInput = {
  base: string
  title: string
  body: string
  draft: boolean
  provider?: HostedReviewProvider
  useTemplate?: boolean
}

/** Generation preferences only; routing comes from the context's `target`. */
export type RuntimeGitPrefs = Partial<
  Pick<
    GlobalSettings,
    'commitMessageAi' | 'sourceControlAi' | 'agentCmdOverrides' | 'defaultTuiAgent'
  >
>

export type RuntimeDiscoverCommitMessageModelsResult =
  | {
      success: true
      capability: CommitMessageAgentCapability
      models: CommitMessageModelCapability[]
      defaultModelId: string
      /** Missing only when an older remote runtime produced the response. */
      catalogOrigin?: 'probe' | 'spec'
    }
  | { success: false; error: string }

export type RuntimeGitContext = {
  /** Transport to the worktree's owner. */
  target: RuntimeClientTarget
  prefs?: RuntimeGitPrefs | null
  worktreeId: string | null | undefined
  worktreePath: string
  connectionId?: string
}

export type RuntimeGenerateCommitMessageOverrides = {
  sourceControlAiResolvedParams?: ResolvedSourceControlAiGenerationParams
  sourceControlAi?: GlobalSettings['sourceControlAi']
  agentCmdOverrides?: GlobalSettings['agentCmdOverrides']
}

export type RuntimeGeneratePullRequestFieldsOverrides = RuntimeGenerateCommitMessageOverrides

export function resolveLocalWorktreePath(context: RuntimeGitContext): string {
  return context.worktreeId
    ? (splitWorktreeIdForFilesystem(context.worktreeId)?.worktreePath ?? context.worktreePath)
    : context.worktreePath
}

export function getRuntimeGitScope(
  target: RuntimeClientTarget,
  connectionId: string | null | undefined
): string | null | undefined {
  return target.kind === 'environment' ? `runtime:${target.environmentId}` : connectionId
}

export function getRuntimeCommitMessageSettings(
  target: RuntimeClientTarget,
  settings: RuntimeGitPrefs | null | undefined,
  connectionId?: string
): Partial<
  Pick<
    GlobalSettings,
    'commitMessageAi' | 'sourceControlAi' | 'agentCmdOverrides' | 'defaultTuiAgent'
  >
> & {
  commitMessageDiscoveryHostKey?: string
} {
  const scope = getRuntimeGitScope(target, connectionId)
  if (!settings) {
    // Why: the host key comes from the route, so a call without prefs still keys its models.
    return { commitMessageDiscoveryHostKey: getCommitMessageModelDiscoveryHostKeyForScope(scope) }
  }
  return {
    ...(settings.commitMessageAi !== undefined
      ? { commitMessageAi: settings.commitMessageAi }
      : {}),
    ...(settings.sourceControlAi !== undefined
      ? { sourceControlAi: settings.sourceControlAi }
      : {}),
    ...(settings.agentCmdOverrides !== undefined
      ? { agentCmdOverrides: settings.agentCmdOverrides }
      : {}),
    ...(settings.defaultTuiAgent !== undefined
      ? { defaultTuiAgent: settings.defaultTuiAgent }
      : {}),
    commitMessageDiscoveryHostKey: getCommitMessageModelDiscoveryHostKeyForScope(scope)
  }
}
