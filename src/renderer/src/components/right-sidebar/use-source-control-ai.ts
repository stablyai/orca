import { useCallback, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { getRuntimeGitScope } from '@/runtime/runtime-git-client'
import { getCommitMessageModelDiscoveryHostKeyForScope } from '../../../../shared/commit-message-host-key'
import {
  DEFAULT_SOURCE_CONTROL_AI_PR_CREATION_DEFAULTS,
  resolveSourceControlActionRecipe,
  resolveSourceControlAiForOperation,
  resolveSourceControlAiPrCreationDefaults,
  type ResolvedSourceControlAiGenerationParams
} from '../../../../shared/source-control-ai'
import type {
  SourceControlActionRecipe,
  SourceControlLaunchActionId,
  SourceControlTextActionId
} from '../../../../shared/source-control-ai-actions'
import type { SourceControlAiWriteTarget } from '../../../../shared/source-control-ai-recipe-save'
import {
  buildFixCommitFailurePrompt,
  buildResolveConflictsPrompt
} from './source-control-ai-prompts'
import { summarizeCommitFailure } from './commit-failure-summary'
import { launchCommitFailureAgentWithDefault } from './source-control-ai-commit-failure-launch'
import {
  saveSourceControlAiActionRecipeForTarget,
  saveSourceControlTextGenerationDefaults
} from './source-control-ai-recipe-persistence'
import type { SourceControlAiControllerParams } from './source-control-ai-controller-types'
import { openSourceControlAiSettingsTarget } from './source-control-ai-settings-navigation'
import { translate } from '@/i18n/i18n'

export function getSourceControlAiControllerDiscoveryHostKey(
  settings: SourceControlAiControllerParams['settings'],
  activeConnectionId: string | null | undefined
): string {
  return getCommitMessageModelDiscoveryHostKeyForScope(
    getRuntimeGitScope(settings, activeConnectionId)
  )
}

export function useSourceControlAi({
  settings,
  activeRepo,
  activeWorktreeId,
  activeConnectionId,
  activeGroupId,
  activeSourceControlLaunchPlatform,
  conflictOperation,
  unresolvedConflicts,
  stagedEntries,
  worktreePath,
  commitMessage,
  commitError,
  updateSettings,
  updateRepo,
  openSettingsTarget,
  openSettingsPage,
  getStoreState = useAppStore.getState
}: SourceControlAiControllerParams) {
  const [resolveConflictsComposerOpen, setResolveConflictsComposerOpen] = useState(false)
  const [commitGenerationDialogOpen, setCommitGenerationDialogOpen] = useState(false)
  const [pullRequestGenerationDialogOpen, setPullRequestGenerationDialogOpen] = useState(false)
  const [isLaunchingCommitFailureAgent, setIsLaunchingCommitFailureAgent] = useState(false)

  const sourceControlAiDiscoveryHostKey = useMemo(
    () => getSourceControlAiControllerDiscoveryHostKey(settings, activeConnectionId),
    [activeConnectionId, settings]
  )
  const resolvedCommitMessageAi = useMemo(
    () =>
      settings
        ? resolveSourceControlAiForOperation({
            settings,
            repo: activeRepo,
            operation: 'commitMessage',
            discoveryHostKey: sourceControlAiDiscoveryHostKey
          })
        : null,
    [activeRepo, settings, sourceControlAiDiscoveryHostKey]
  )
  const resolvedPrCreationDefaults = useMemo(() => {
    if (!settings) {
      return DEFAULT_SOURCE_CONTROL_AI_PR_CREATION_DEFAULTS
    }
    const resolved = resolveSourceControlAiForOperation({
      settings,
      repo: activeRepo,
      operation: 'pullRequest',
      discoveryHostKey: sourceControlAiDiscoveryHostKey,
      prCreationProductDefaults: DEFAULT_SOURCE_CONTROL_AI_PR_CREATION_DEFAULTS
    })
    return resolved.ok
      ? resolved.value.prCreationDefaults
      : resolveSourceControlAiPrCreationDefaults({
          settings,
          repo: activeRepo,
          prCreationProductDefaults: DEFAULT_SOURCE_CONTROL_AI_PR_CREATION_DEFAULTS
        })
  }, [activeRepo, settings, sourceControlAiDiscoveryHostKey])

  const getLaunchActionRecipe = useCallback(
    (actionId: SourceControlLaunchActionId): SourceControlActionRecipe =>
      resolveSourceControlActionRecipe({
        settings,
        repo: activeRepo,
        actionId
      }),
    [activeRepo, settings]
  )
  const saveActionRecipeForTarget = useCallback(
    async (
      target: SourceControlAiWriteTarget,
      actionId: SourceControlTextActionId | SourceControlLaunchActionId,
      recipe: SourceControlActionRecipe,
      customAgentCommand?: string
    ): Promise<void> => {
      await saveSourceControlAiActionRecipeForTarget({
        getStoreState,
        updateSettings,
        updateRepo,
        target,
        actionId,
        recipe,
        customAgentCommand
      })
    },
    [getStoreState, updateRepo, updateSettings]
  )
  const saveLaunchActionDefault = useCallback(
    async (
      target: SourceControlAiWriteTarget,
      actionId: SourceControlLaunchActionId,
      recipe: SourceControlActionRecipe
    ): Promise<void> => {
      await saveActionRecipeForTarget(target, actionId, recipe)
    },
    [saveActionRecipeForTarget]
  )

  const openSourceControlAiSettings = useCallback((): void => {
    openSourceControlAiSettingsTarget({
      activeRepo,
      openSettingsTarget,
      openSettingsPage
    })
  }, [activeRepo, openSettingsPage, openSettingsTarget])

  const resolveConflictsPrompt = useMemo(
    () =>
      buildResolveConflictsPrompt({
        conflictOperation,
        entries: unresolvedConflicts,
        worktreePath
      }),
    [conflictOperation, unresolvedConflicts, worktreePath]
  )
  const handleResolveConflictsWithAI = useCallback((): void => {
    if (!activeWorktreeId) {
      return
    }
    if (unresolvedConflicts.length === 0) {
      toast.message(translate("auto.components.right.sidebar.use.source.control.ai.cfafa92509", "No unresolved conflicts to send."))
      return
    }
    setResolveConflictsComposerOpen(true)
  }, [activeWorktreeId, unresolvedConflicts.length])

  const commitFailureRecoveryPrompt = useMemo(
    () =>
      commitError
        ? buildFixCommitFailurePrompt({
            summary: summarizeCommitFailure(commitError),
            error: commitError,
            entries: stagedEntries,
            worktreePath,
            commitMessage
          })
        : null,
    [commitError, commitMessage, stagedEntries, worktreePath]
  )
  const handleFixCommitFailureWithAI = useCallback(
    async (promptOverride?: string): Promise<boolean> => {
      if (isLaunchingCommitFailureAgent || !activeWorktreeId || !commitError) {
        return false
      }

      setIsLaunchingCommitFailureAgent(true)
      try {
        return await launchCommitFailureAgentWithDefault({
          activeWorktreeId,
          activeGroupId,
          activeSourceControlLaunchPlatform,
          sourceRepoConnectionId: activeConnectionId ?? activeRepo?.connectionId ?? null,
          commitFailureRecoveryPrompt,
          promptOverride,
          getLaunchActionRecipe,
          getStoreState
        })
      } finally {
        setIsLaunchingCommitFailureAgent(false)
      }
    },
    [
      activeGroupId,
      activeConnectionId,
      activeRepo?.connectionId,
      activeWorktreeId,
      activeSourceControlLaunchPlatform,
      commitError,
      commitFailureRecoveryPrompt,
      getLaunchActionRecipe,
      getStoreState,
      isLaunchingCommitFailureAgent
    ]
  )

  const handleSaveCommitMessageGenerationDefaults = useCallback(
    async (
      target: SourceControlAiWriteTarget,
      params: ResolvedSourceControlAiGenerationParams
    ): Promise<void> => {
      await saveSourceControlTextGenerationDefaults({
        saveActionRecipeForTarget,
        target,
        actionId: 'commitMessage',
        params
      })
    },
    [saveActionRecipeForTarget]
  )

  const handleSavePullRequestGenerationDefaults = useCallback(
    async (
      target: SourceControlAiWriteTarget,
      params: ResolvedSourceControlAiGenerationParams
    ): Promise<void> => {
      await saveSourceControlTextGenerationDefaults({
        saveActionRecipeForTarget,
        target,
        actionId: 'pullRequest',
        params
      })
    },
    [saveActionRecipeForTarget]
  )

  const openCommitGenerationDialog = useCallback((): void => {
    setCommitGenerationDialogOpen(true)
  }, [])
  const openPullRequestGenerationDialog = useCallback((): void => {
    setPullRequestGenerationDialogOpen(true)
  }, [])

  return {
    sourceControlAiDiscoveryHostKey,
    resolvedCommitMessageAi,
    resolvedPrCreationDefaults,
    resolveConflictsComposerOpen,
    setResolveConflictsComposerOpen,
    commitGenerationDialogOpen,
    setCommitGenerationDialogOpen,
    pullRequestGenerationDialogOpen,
    setPullRequestGenerationDialogOpen,
    openCommitGenerationDialog,
    openPullRequestGenerationDialog,
    isLaunchingCommitFailureAgent,
    resolveConflictsPrompt,
    commitFailureRecoveryPrompt,
    getLaunchActionRecipe,
    saveLaunchActionDefault,
    handleResolveConflictsWithAI,
    handleFixCommitFailureWithAI,
    handleSaveCommitMessageGenerationDefaults,
    handleSavePullRequestGenerationDefaults,
    openSourceControlAiSettings
  }
}
