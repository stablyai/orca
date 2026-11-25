import type {
  CommitMessageAgentCapability,
  CommitMessageModelCapability
} from '../../../../../shared/source-control/ai/generation/commit-message-agent-spec'
import {
  getCommitMessageModelDiscoveryHostKeyForScope,
  getRepoCommitMessageModelDiscoveryHostKey
} from '../../../../../shared/source-control/ai/generation/commit-message-host-key'
import type { GlobalSettings } from '../../../../../shared/settings/global-settings-types'
import {
  pickCommitMessageGenerationSettings,
  type CommitMessageGenerationSettings
} from '../../../../../shared/source-control/ai/generation/commit-message-generation-settings'
import type { HostedReviewProvider } from '../../../../../shared/source-control/hosted-review/hosted-review-contracts'
import type { ResolvedSourceControlAiGenerationParams } from '../../../../../shared/source-control/ai/source-control-ai-operation-resolution'
import { splitWorktreeIdForFilesystem } from '../../../../../shared/worktree/id'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type { TextGenerationFailureFields } from '../../../../../shared/text-generation/text-generation-failure-copy'

export type RuntimeGenerateCommitMessageResult =
  | { success: true; message: string; agentLabel?: string }
  | ({ success: false; canceled?: boolean } & TextGenerationFailureFields)

export type RuntimeGeneratePullRequestFieldsResult =
  | {
      success: true
      fields: { base: string; title: string; body: string; draft: boolean }
      agentLabel?: string
      branchChangedByPreparation?: boolean
    }
  | ({
      success: false
      canceled?: boolean
      branchChangedByPreparation?: boolean
    } & TextGenerationFailureFields)

export type RuntimePullRequestGenerationInput = {
  base: string
  title: string
  body: string
  draft: boolean
  provider?: HostedReviewProvider
  useTemplate?: boolean
}

/** Generation preferences only; routing comes from the context's `target`. */
export type RuntimeGitPrefs = CommitMessageGenerationSettings

export type RuntimeDiscoverCommitMessageModelsResult =
  | {
      success: true
      capability: CommitMessageAgentCapability
      models: CommitMessageModelCapability[]
      defaultModelId: string
      /** Missing only when an older remote runtime produced the response. */
      catalogOrigin?: 'probe' | 'spec'
      /** Some providers could not be read. Their saved choices are still valid. */
      partial?: true
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

/** The host key a repo's text-model picks are saved under, so generation reads the pick the picker wrote. */
export function getRuntimeGitRepoDiscoveryHostKey(
  target: RuntimeClientTarget,
  repo: { connectionId?: string | null; executionHostId?: string | null } | null | undefined,
  connectionId: string | null | undefined
): string {
  // Why: without a loaded repo record only the connection can say where it runs; unknown keeps no host's pick.
  return target.kind !== 'environment' && repo
    ? getRepoCommitMessageModelDiscoveryHostKey(repo)
    : getCommitMessageModelDiscoveryHostKeyForScope(getRuntimeGitScope(target, connectionId))
}

export function getRuntimeCommitMessageSettings(
  target: RuntimeClientTarget,
  settings: RuntimeGitPrefs | null | undefined,
  connectionId?: string
): CommitMessageGenerationSettings & {
  commitMessageDiscoveryHostKey?: string
} {
  const scope = getRuntimeGitScope(target, connectionId)
  if (!settings) {
    // Why: the host key comes from the route, so a call without prefs still keys its models.
    return { commitMessageDiscoveryHostKey: getCommitMessageModelDiscoveryHostKeyForScope(scope) }
  }
  return {
    ...pickCommitMessageGenerationSettings(settings),
    commitMessageDiscoveryHostKey: getCommitMessageModelDiscoveryHostKeyForScope(scope)
  }
}
