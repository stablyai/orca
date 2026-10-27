import { useSavedSourceControlActionStart } from '../../use-saved-source-control-action-start'
import type { SourceControlAgentActionDialogProps } from '../../SourceControlAgentActionDialog'
import { useCallback, useMemo, useState } from 'react'
import { useAppStore } from '@/store'
import { getRuntimeGitScope } from '@/runtime/runtime-git-client-context'
import { getCommitMessageModelDiscoveryHostKeyForScope } from '../../../../../../shared/commit-message-host-key'
import {
  DEFAULT_SOURCE_CONTROL_AI_PR_CREATION_DEFAULTS,
  resolveSourceControlActionRecipe,
  resolveSourceControlAiEnabled,
  resolveSourceControlAiForOperation,
  resolveSourceControlAiPrCreationDefaults,
  type ResolvedSourceControlAiGenerationParams
} from '../../../../../../shared/source-control-ai'
import type {
  SourceControlActionRecipe,
  SourceControlLaunchActionId,
  SourceControlTextActionId
} from '../../../../../../shared/source-control-ai-actions'
import type { SourceControlAiWriteTarget } from '../../../../../../shared/source-control-ai-recipe-save'
import {
  saveSourceControlAiActionRecipeForTarget,
  saveSourceControlTextGenerationDefaults
} from './recipe-persistence'
import type { SourceControlAiControllerParams } from './controller-types'
import { openSourceControlAiSettingsTarget } from '../../source-control-ai-settings-navigation'
import { useSourceControlRecoveryAi } from './use-recovery-ai'
import { useConflictRecoveryComposer } from './use-conflict-recovery-composer'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'

export function getSourceControlAiControllerDiscoveryHostKey(
  target: SourceControlAiControllerParams['target'],
  activeConnectionId: string | null | undefined
): string {
  return getCommitMessageModelDiscoveryHostKeyForScope(
    getRuntimeGitScope(target ?? { kind: 'local' }, activeConnectionId)
  )
}

export function useSourceControlAi({
  settings,
  target,
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
  pushRecoveryPrompt,
  updateSettings,
  updateSettingsOrThrow,
  updateRepo,
  openSettingsTarget,
  openSettingsPage,
  getStoreState = useAppStore.getState
}: SourceControlAiControllerParams) {
  const savedStart = useSavedSourceControlActionStart()
  const [resolveConflictsEditor, setResolveConflictsEditor] = useState<
    Partial<SourceControlAgentActionDialogProps>
  >({})
  const [commitGenerationDialogOpen, setCommitGenerationDialogOpen] = useState(false)
  const [pullRequestGenerationDialogOpen, setPullRequestGenerationDialogOpen] = useState(false)

  const sourceControlAiDiscoveryHostKey = getSourceControlAiControllerDiscoveryHostKey(
    target,
    activeConnectionId
  )
  const sourceControlAiActionsVisible = useMemo(
    () => (settings ? resolveSourceControlAiEnabled({ settings, repo: activeRepo }) : false),
    [activeRepo, settings]
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
      resolveSourceControlActionRecipe({ settings, repo: activeRepo, actionId }),
    [activeRepo, settings]
  )
  const saveActionRecipeForTarget = useCallback(
    (
      target: SourceControlAiWriteTarget,
      actionId: SourceControlTextActionId | SourceControlLaunchActionId,
      recipe: SourceControlActionRecipe,
      customAgentCommand?: string
    ): Promise<void> =>
      saveSourceControlAiActionRecipeForTarget({
        getStoreState,
        updateSettings,
        updateRepo,
        target,
        actionId,
        recipe,
        customAgentCommand
      }),
    [getStoreState, updateRepo, updateSettings]
  )
  const saveLaunchActionDefault = useCallback(
    (
      target: SourceControlAiWriteTarget,
      actionId: SourceControlLaunchActionId,
      recipe: SourceControlActionRecipe
    ): Promise<void> =>
      saveSourceControlAiActionRecipeForTarget({
        getStoreState,
        updateSettings: updateSettingsOrThrow,
        updateRepo,
        target,
        actionId,
        recipe
      }),
    [getStoreState, updateRepo, updateSettingsOrThrow]
  )

  const openSourceControlAiSettings = useCallback((): void => {
    openSourceControlAiSettingsTarget({
      activeRepo,
      openSettingsTarget,
      openSettingsPage
    })
  }, [activeRepo, openSettingsPage, openSettingsTarget])

  const {
    resolveConflictsPrompt,
    resolveConflictsComposerOpen,
    isCheckingRecoveryAdmission,
    resolveConflictsRecoveryContext,
    setResolveConflictsComposerOpen,
    handleResolveConflictsWithAI
  } = useConflictRecoveryComposer({
    target,
    activeWorktreeId,
    activeConnectionId,
    conflictOperation,
    unresolvedConflicts,
    worktreePath,
    onAdmitted: async (recoveryContext, signal) => {
      const editor = {
        initialRecipe: getLaunchActionRecipe('resolveConflicts'),
        recoveryContext,
        baseCommandInput: resolveConflictsPrompt,
        worktreeId: activeWorktreeId,
        groupId: activeGroupId,
        connectionId: activeConnectionId,
        repoId: activeRepo?.id,
        launchPlatform: activeSourceControlLaunchPlatform
      }
      await savedStart.start({
        recipe: editor.initialRecipe,
        basePrompt: resolveConflictsPrompt,
        ...editor,
        actionId: 'resolveConflicts',
        settings,
        repo: activeRepo,
        promptDelivery: 'submit-after-ready',
        launchSource: 'conflict_resolution',
        signal,
        onClose: () => {},
        onLaunched: () =>
          toast.success(
            translate(
              'auto.components.right.sidebar.SourceControl.e48caaf0dd',
              'Started an AI agent for the conflicts.'
            )
          ),
        onFallback: () => {
          if (signal.aborted) {
            return
          }
          setResolveConflictsEditor(editor)
          setResolveConflictsComposerOpen(true)
        }
      })
    }
  })

  const {
    isLaunchingCommitFailureAgent,
    isLaunchingPushFailureAgent,
    commitFailureRecoveryPrompt,
    pushFailureRecoveryPrompt,
    handleFixCommitFailureWithAI,
    handleFixPushFailureWithAI
  } = useSourceControlRecoveryAi({
    activeWorktreeId,
    activeGroupId,
    activeSourceControlLaunchPlatform,
    sourceRepoConnectionId: activeRepo?.connectionId,
    worktreePath,
    commitMessage,
    commitError,
    pushRecoveryPrompt,
    stagedEntries,
    getLaunchActionRecipe,
    getStoreState
  })

  const handleSaveCommitMessageGenerationDefaults = useCallback(
    (
      target: SourceControlAiWriteTarget,
      params: ResolvedSourceControlAiGenerationParams
    ): Promise<void> =>
      saveSourceControlTextGenerationDefaults({
        saveActionRecipeForTarget,
        target,
        actionId: 'commitMessage',
        params
      }),
    [saveActionRecipeForTarget]
  )

  const handleSavePullRequestGenerationDefaults = useCallback(
    (
      target: SourceControlAiWriteTarget,
      params: ResolvedSourceControlAiGenerationParams
    ): Promise<void> =>
      saveSourceControlTextGenerationDefaults({
        saveActionRecipeForTarget,
        target,
        actionId: 'pullRequest',
        params
      }),
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
    isCheckingRecoveryAdmission,
    resolveConflictsRecoveryContext,
    sourceControlAiActionsVisible,
    resolvedCommitMessageAi,
    resolvedPrCreationDefaults,
    resolveConflictsEditor,
    isResolvingConflictsWithAI: savedStart.isStarting,
    resolveConflictsComposerOpen,
    setResolveConflictsComposerOpen,
    commitGenerationDialogOpen,
    setCommitGenerationDialogOpen,
    pullRequestGenerationDialogOpen,
    setPullRequestGenerationDialogOpen,
    openCommitGenerationDialog,
    openPullRequestGenerationDialog,
    isLaunchingCommitFailureAgent,
    isLaunchingPushFailureAgent,
    resolveConflictsPrompt,
    commitFailureRecoveryPrompt,
    pushFailureRecoveryPrompt,
    getLaunchActionRecipe,
    saveLaunchActionDefault,
    handleResolveConflictsWithAI,
    handleFixCommitFailureWithAI,
    handleFixPushFailureWithAI,
    handleSaveCommitMessageGenerationDefaults,
    handleSavePullRequestGenerationDefaults,
    openSourceControlAiSettings
  }
}

export type SourceControlAi = ReturnType<typeof useSourceControlAi>
