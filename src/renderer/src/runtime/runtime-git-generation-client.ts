import { getRepoIdFromWorktreeId } from '../../../shared/worktree/id'
import { TEXT_GENERATION_CLIENT_TIMEOUT_MS } from '../../../shared/text-generation-client-timeout'
import {
  localizeTextGenerationResult,
  textGenerationCopyText
} from '@/lib/text-generation-error-copy'
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
import { callRuntimeRpc } from './runtime-rpc-client'
import { toRuntimeWorktreeSelector } from './runtime-worktree-selector'

export async function generateRuntimeCommitMessage(
  context: RuntimeGitContext,
  overrides?: RuntimeGenerateCommitMessageOverrides,
  isCanceled?: () => boolean
): Promise<RuntimeGenerateCommitMessageResult> {
  if (isCanceled?.()) {
    return {
      success: false as const,
      error: textGenerationCopyText('generationCanceled'),
      canceled: true
    }
  }
  const target = context.target
  if (target.kind === 'local' || !context.worktreeId) {
    const result = await window.api.git.generateCommitMessage({
      worktreePath: resolveLocalWorktreePath(context),
      // Why: the workspace suffix is part of the worktree metadata key.
      ...(context.worktreeId ? { worktreeId: context.worktreeId } : {}),
      repoId: context.worktreeId ? getRepoIdFromWorktreeId(context.worktreeId) : undefined,
      connectionId: context.connectionId,
      ...(context.generationId ? { generationId: context.generationId } : {}),
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
  if (isCanceled?.()) {
    return {
      success: false as const,
      error: textGenerationCopyText('generationCanceled'),
      canceled: true
    }
  }
  if (compatibilityError) {
    return { success: false as const, error: compatibilityError }
  }
  const result = await callRuntimeRpc<RuntimeGenerateCommitMessageResult>(
    target,
    'git.generateCommitMessage',
    {
      worktree: toRuntimeWorktreeSelector(context.worktreeId),
      ...(context.generationId ? { generationId: context.generationId } : {}),
      ...getRuntimeCommitMessageSettings(context.target, context.prefs, context.connectionId),
      ...(overrides?.sourceControlAiResolvedParams
        ? { sourceControlAiResolvedParams: overrides.sourceControlAiResolvedParams }
        : {}),
      ...(overrides?.sourceControlAi ? { sourceControlAi: overrides.sourceControlAi } : {}),
      ...(overrides?.agentCmdOverrides ? { agentCmdOverrides: overrides.agentCmdOverrides } : {})
    },
    { timeoutMs: TEXT_GENERATION_CLIENT_TIMEOUT_MS, ...(isCanceled ? { isCanceled } : {}) }
  ).catch((error) => {
    if (isCanceled?.()) {
      return {
        success: false as const,
        error: textGenerationCopyText('generationCanceled'),
        canceled: true
      }
    }
    throw error
  })
  return localizeTextGenerationResult(result)
}

export async function discoverRuntimeCommitMessageModels(
  context: RuntimeGitContext,
  agentId: string
): Promise<RuntimeDiscoverCommitMessageModelsResult> {
  const target = context.target
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
  // Client-side isCanceled guards read this flag; set it before any transport round-trip.
  if (context.generationCancellation) {
    context.generationCancellation.canceled = true
  }
  const target = context.target
  if (target.kind === 'local' || !context.worktreeId) {
    await window.api.git.cancelGenerateCommitMessage({
      worktreePath: resolveLocalWorktreePath(context),
      connectionId: context.connectionId,
      ...(context.generationId ? { generationId: context.generationId } : {})
    })
    return
  }
  await callRuntimeRpc(
    target,
    'git.cancelGenerateCommitMessage',
    {
      worktree: toRuntimeWorktreeSelector(context.worktreeId),
      ...(context.generationId ? { generationId: context.generationId } : {})
    },
    { timeoutMs: 5_000 }
  )
}

export async function generateRuntimePullRequestFields(
  context: RuntimeGitContext,
  input: RuntimePullRequestGenerationInput,
  overrides?: RuntimeGeneratePullRequestFieldsOverrides,
  isCanceled?: () => boolean
): Promise<RuntimeGeneratePullRequestFieldsResult> {
  if (isCanceled?.()) {
    return {
      success: false as const,
      error: textGenerationCopyText('generationCanceled'),
      canceled: true
    }
  }
  const target = context.target
  if (target.kind === 'local' || !context.worktreeId) {
    const result = await window.api.git.generatePullRequestFields({
      worktreePath: resolveLocalWorktreePath(context),
      // Why: the workspace suffix is part of the worktree metadata key.
      ...(context.worktreeId ? { worktreeId: context.worktreeId } : {}),
      repoId: context.worktreeId ? getRepoIdFromWorktreeId(context.worktreeId) : undefined,
      connectionId: context.connectionId,
      ...(context.generationId ? { generationId: context.generationId } : {}),
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
  if (isCanceled?.()) {
    return {
      success: false as const,
      error: textGenerationCopyText('generationCanceled'),
      canceled: true
    }
  }
  if (compatibilityError) {
    return { success: false as const, error: compatibilityError }
  }
  const result = await callRuntimeRpc<RuntimeGeneratePullRequestFieldsResult>(
    target,
    'git.generatePullRequestFields',
    {
      worktree: toRuntimeWorktreeSelector(context.worktreeId),
      ...(context.generationId ? { generationId: context.generationId } : {}),
      ...input,
      ...getRuntimeCommitMessageSettings(context.target, context.prefs, context.connectionId),
      ...(overrides?.sourceControlAiResolvedParams
        ? { sourceControlAiResolvedParams: overrides.sourceControlAiResolvedParams }
        : {}),
      ...(overrides?.sourceControlAi ? { sourceControlAi: overrides.sourceControlAi } : {}),
      ...(overrides?.agentCmdOverrides ? { agentCmdOverrides: overrides.agentCmdOverrides } : {})
    },
    { timeoutMs: TEXT_GENERATION_CLIENT_TIMEOUT_MS, ...(isCanceled ? { isCanceled } : {}) }
  ).catch((error) => {
    if (isCanceled?.()) {
      return {
        success: false as const,
        error: textGenerationCopyText('generationCanceled'),
        canceled: true
      }
    }
    throw error
  })
  return localizeTextGenerationResult(result)
}

export async function cancelRuntimeGeneratePullRequestFields(
  context: RuntimeGitContext
): Promise<void> {
  if (context.generationCancellation) {
    context.generationCancellation.canceled = true
  }
  const target = context.target
  if (target.kind === 'local' || !context.worktreeId) {
    await window.api.git.cancelGeneratePullRequestFields({
      worktreePath: resolveLocalWorktreePath(context),
      connectionId: context.connectionId,
      ...(context.generationId ? { generationId: context.generationId } : {})
    })
    return
  }
  await callRuntimeRpc(
    target,
    'git.cancelGeneratePullRequestFields',
    {
      worktree: toRuntimeWorktreeSelector(context.worktreeId),
      ...(context.generationId ? { generationId: context.generationId } : {})
    },
    { timeoutMs: 5_000 }
  )
}
