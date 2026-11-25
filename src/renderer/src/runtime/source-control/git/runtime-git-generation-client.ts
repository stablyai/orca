import { getRepoIdFromWorktreeId } from '../../../../../shared/worktree/id'
import { TEXT_GENERATION_CLIENT_TIMEOUT_MS } from '../../../../../shared/text-generation/text-generation-client-timeout'
import { localizeTextGenerationResult } from '@/lib/text-generation/text-generation-error-copy'
import { antigravityGenerationCompatibilityError } from './antigravity-generation-compatibility'
import {
  getRuntimeCommitMessageSettings,
  resolveLocalWorktreePath,
  type RuntimeDiscoverCommitMessageModelsResult,
  type RuntimeGenerateCommitMessageOverrides,
  type RuntimeGenerateCommitMessageResult,
  type RuntimeGeneratePullRequestFieldsOverrides,
  type RuntimeGeneratePullRequestFieldsResult,
  type RuntimeGitContext,
  type RuntimePullRequestGenerationInput
} from './runtime-git-client-context'
import { callRuntimeRpc } from '../../rpc/calls/runtime-rpc-call'
import { toRuntimeWorktreeSelector } from '../../rpc/targets/runtime-worktree-selector'
import { DOUBAO_SSH_MODEL_DISCOVERY_CAPABILITY } from '../../../../../shared/source-control/runtime/source-control-runtime-capabilities'
import { runtimeEnvironmentSupportsCapability } from '../../rpc/compatibility/runtime-capability-proof'
import { getRuntimeEnvironmentRevision } from '../../rpc/environment-revisions/runtime-environment-revision'
import { translate } from '@/i18n/i18n'

export async function generateRuntimeCommitMessage(
  context: RuntimeGitContext,
  overrides?: RuntimeGenerateCommitMessageOverrides
): Promise<RuntimeGenerateCommitMessageResult> {
  const target = context.target
  if (target.kind === 'local' || !context.worktreeId) {
    const result = await window.api.git.generateCommitMessage({
      worktreePath: resolveLocalWorktreePath(context),
      // Why: the workspace suffix is part of the worktree metadata key.
      ...(context.worktreeId ? { worktreeId: context.worktreeId } : {}),
      repoId: context.worktreeId ? getRepoIdFromWorktreeId(context.worktreeId) : undefined,
      connectionId: context.connectionId,
      ...(overrides?.sourceControlAiResolvedParams
        ? { sourceControlAiResolvedParams: overrides.sourceControlAiResolvedParams }
        : {}),
      ...(overrides?.sourceControlAi ? { sourceControlAi: overrides.sourceControlAi } : {}),
      ...(overrides?.agentCmdOverrides ? { agentCmdOverrides: overrides.agentCmdOverrides } : {})
    })
    return localizeTextGenerationResult(result)
  }
  const compatibilityError = await antigravityGenerationCompatibilityError(
    target.environmentId,
    context,
    'commitMessage',
    overrides
  )
  if (compatibilityError) {
    return { success: false, error: compatibilityError }
  }
  const result = await callRuntimeRpc<RuntimeGenerateCommitMessageResult>(
    target,
    'git.generateCommitMessage',
    {
      worktree: toRuntimeWorktreeSelector(context.worktreeId),
      ...getRuntimeCommitMessageSettings(context.target, context.prefs, context.connectionId),
      ...(overrides?.sourceControlAiResolvedParams
        ? { sourceControlAiResolvedParams: overrides.sourceControlAiResolvedParams }
        : {}),
      ...(overrides?.sourceControlAi ? { sourceControlAi: overrides.sourceControlAi } : {}),
      ...(overrides?.agentCmdOverrides ? { agentCmdOverrides: overrides.agentCmdOverrides } : {})
    },
    { timeoutMs: TEXT_GENERATION_CLIENT_TIMEOUT_MS }
  )
  return localizeTextGenerationResult(result)
}

export async function discoverRuntimeCommitMessageModels(
  context: RuntimeGitContext,
  agentId: string,
  signal?: AbortSignal
): Promise<RuntimeDiscoverCommitMessageModelsResult> {
  const target = context.target
  if (agentId === 'doubao' && context.connectionId && context.worktreeId) {
    const expectedEnvironmentPairingRevision =
      target.kind === 'environment'
        ? getRuntimeEnvironmentRevision(target.environmentId)
        : undefined
    if (
      target.kind === 'environment' &&
      !(await runtimeEnvironmentSupportsCapability(
        target.environmentId,
        DOUBAO_SSH_MODEL_DISCOVERY_CAPABILITY
      ))
    ) {
      return {
        success: false,
        error: translate(
          'agentLaunch.updateServer',
          'Update Orca on this workspace’s server, then try again.'
        )
      }
    }
    return callRuntimeRpc<RuntimeDiscoverCommitMessageModelsResult>(
      target,
      'git.discoverCommitMessageModels',
      {
        worktree: toRuntimeWorktreeSelector(context.worktreeId),
        agentId,
        expectedConnectionId: context.connectionId
      },
      { timeoutMs: TEXT_GENERATION_CLIENT_TIMEOUT_MS, expectedEnvironmentPairingRevision, signal }
    )
  }
  if (target.kind === 'local' || !context.worktreeId) {
    return window.api.git.discoverCommitMessageModels({
      agentId,
      worktreePath: resolveLocalWorktreePath(context),
      connectionId: context.connectionId
    }) as Promise<RuntimeDiscoverCommitMessageModelsResult>
  }
  return callRuntimeRpc<RuntimeDiscoverCommitMessageModelsResult>(
    target,
    'git.discoverCommitMessageModels',
    {
      worktree: toRuntimeWorktreeSelector(context.worktreeId),
      agentId,
      ...(context.prefs?.agentCmdOverrides
        ? { agentCmdOverrides: context.prefs.agentCmdOverrides }
        : {})
    },
    { timeoutMs: TEXT_GENERATION_CLIENT_TIMEOUT_MS }
  )
}

export async function cancelRuntimeGenerateCommitMessage(
  context: RuntimeGitContext
): Promise<void> {
  const target = context.target
  if (target.kind === 'local' || !context.worktreeId) {
    await window.api.git.cancelGenerateCommitMessage({
      worktreePath: resolveLocalWorktreePath(context),
      connectionId: context.connectionId
    })
    return
  }
  await callRuntimeRpc(
    target,
    'git.cancelGenerateCommitMessage',
    { worktree: toRuntimeWorktreeSelector(context.worktreeId) },
    { timeoutMs: 5_000 }
  )
}

export async function generateRuntimePullRequestFields(
  context: RuntimeGitContext,
  input: RuntimePullRequestGenerationInput,
  overrides?: RuntimeGeneratePullRequestFieldsOverrides
): Promise<RuntimeGeneratePullRequestFieldsResult> {
  const target = context.target
  if (target.kind === 'local' || !context.worktreeId) {
    const result = await window.api.git.generatePullRequestFields({
      worktreePath: resolveLocalWorktreePath(context),
      // Why: the workspace suffix is part of the worktree metadata key.
      ...(context.worktreeId ? { worktreeId: context.worktreeId } : {}),
      repoId: context.worktreeId ? getRepoIdFromWorktreeId(context.worktreeId) : undefined,
      connectionId: context.connectionId,
      ...input,
      ...(overrides?.sourceControlAiResolvedParams
        ? { sourceControlAiResolvedParams: overrides.sourceControlAiResolvedParams }
        : {}),
      ...(overrides?.sourceControlAi ? { sourceControlAi: overrides.sourceControlAi } : {}),
      ...(overrides?.agentCmdOverrides ? { agentCmdOverrides: overrides.agentCmdOverrides } : {})
    })
    return localizeTextGenerationResult(result)
  }
  const compatibilityError = await antigravityGenerationCompatibilityError(
    target.environmentId,
    context,
    'pullRequest',
    overrides
  )
  if (compatibilityError) {
    return { success: false, error: compatibilityError }
  }
  const result = await callRuntimeRpc<RuntimeGeneratePullRequestFieldsResult>(
    target,
    'git.generatePullRequestFields',
    {
      worktree: toRuntimeWorktreeSelector(context.worktreeId),
      ...input,
      ...getRuntimeCommitMessageSettings(context.target, context.prefs, context.connectionId),
      ...(overrides?.sourceControlAiResolvedParams
        ? { sourceControlAiResolvedParams: overrides.sourceControlAiResolvedParams }
        : {}),
      ...(overrides?.sourceControlAi ? { sourceControlAi: overrides.sourceControlAi } : {}),
      ...(overrides?.agentCmdOverrides ? { agentCmdOverrides: overrides.agentCmdOverrides } : {})
    },
    { timeoutMs: TEXT_GENERATION_CLIENT_TIMEOUT_MS }
  )
  return localizeTextGenerationResult(result)
}

export async function cancelRuntimeGeneratePullRequestFields(
  context: RuntimeGitContext
): Promise<void> {
  const target = context.target
  if (target.kind === 'local' || !context.worktreeId) {
    await window.api.git.cancelGeneratePullRequestFields({
      worktreePath: resolveLocalWorktreePath(context),
      connectionId: context.connectionId
    })
    return
  }
  await callRuntimeRpc(
    target,
    'git.cancelGeneratePullRequestFields',
    { worktree: toRuntimeWorktreeSelector(context.worktreeId) },
    { timeoutMs: 5_000 }
  )
}
