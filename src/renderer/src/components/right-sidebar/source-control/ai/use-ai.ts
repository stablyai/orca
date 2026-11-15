import { useSourceControlScope } from '../panel/worktree-scope'
import { repoMatchesHostIdentity } from '@/store/repos/repo-host-identity'
import { getRepoExecutionHostId } from '../../../../../../shared/execution-host'
import {
  captureSourceControlActionSelection,
  resolveSourceControlActionRecipe,
  resolveSourceControlAiEnabled,
  resolveSourceControlAiPrCreationDefaults
} from '../../../../../../shared/source-control/ai/source-control-ai-operation-policy'
import type { SelectedSourceControlActionRecipe } from '../../../../../../shared/source-control/ai/recipes/source-control-action-selection'
import { useSavedSourceControlActionStart } from './use-saved-source-control-action-start'
import type { SourceControlAgentActionDialogProps } from './SourceControlAgentActionDialog'
import { useCallback, useMemo, useState } from 'react'
import { useAppStore } from '@/store'
import { getRuntimeGitRepoDiscoveryHostKey } from '@/runtime/source-control/git/runtime-git-client-context'
import { DEFAULT_SOURCE_CONTROL_AI_PR_CREATION_DEFAULTS } from '../../../../../../shared/source-control/ai/settings/source-control-ai-settings'
import { resolveSourceControlAiForOperation } from '../../../../../../shared/source-control/ai/source-control-ai-operation-resolution'
import type { SourceControlLaunchActionId } from '../../../../../../shared/source-control/ai/recipes/source-control-ai-actions'
import { useSourceControlAiRecipeSaves } from './use-recipe-saves'
import type { SourceControlAiControllerParams } from './controller-types'
import { openSourceControlAiSettingsTarget } from '../panel/source-control-ai-settings-navigation'
import { useSourceControlRecoveryAi } from './use-recovery-ai'
import { useConflictRecoveryComposer } from './use-conflict-recovery-composer'
import { toast } from 'sonner'
import { useTranslate } from '@/i18n/use-translate'

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
  const t = useTranslate()
  const scope = useSourceControlScope()
  const repoHostId = activeRepo ? getRepoExecutionHostId(activeRepo) : undefined
  const savedStart = useSavedSourceControlActionStart()
  const [resolveConflictsEditor, setResolveConflictsEditor] = useState<
    Partial<SourceControlAgentActionDialogProps>
  >({})
  const [commitGenerationDialogOpen, setCommitGenerationDialogOpen] = useState(false)
  const [pullRequestGenerationDialogOpen, setPullRequestGenerationDialogOpen] = useState(false)

  const sourceControlAiDiscoveryHostKey = getRuntimeGitRepoDiscoveryHostKey(
    target ?? { kind: 'local' },
    activeRepo,
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
  const resolvedPrCreationDefaults = useMemo(
    () =>
      settings
        ? resolveSourceControlAiPrCreationDefaults({ settings, repo: activeRepo })
        : DEFAULT_SOURCE_CONTROL_AI_PR_CREATION_DEFAULTS,
    [activeRepo, settings]
  )

  const getLaunchActionRecipe = useCallback(
    (actionId: SourceControlLaunchActionId): SelectedSourceControlActionRecipe =>
      resolveSourceControlActionRecipe({ settings, repo: activeRepo, actionId }),
    [activeRepo, settings]
  )
  const getCurrentLaunchActionRecipe = useCallback(
    (actionId: SourceControlLaunchActionId) => {
      const state = getStoreState()
      const repo = activeRepo
        ? (state.repos.find((candidate) =>
            repoMatchesHostIdentity(candidate, activeRepo.id, getRepoExecutionHostId(activeRepo))
          ) ?? null)
        : null
      return resolveSourceControlActionRecipe({ settings: state.settings, repo, actionId })
    },
    [activeRepo, getStoreState]
  )
  const {
    saveLaunchActionDefault,
    handleSaveCommitMessageGenerationDefaults,
    handleSavePullRequestGenerationDefaults
  } = useSourceControlAiRecipeSaves({
    repoHostId,
    getStoreState,
    updateSettings,
    updateSettingsOrThrow,
    updateRepo
  })

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
        initialSelection: captureSourceControlActionSelection({
          settings: getStoreState().settings,
          repo: activeRepo,
          actionId: 'resolveConflicts'
        }),
        recoveryContext,
        baseCommandInput: resolveConflictsPrompt,
        worktreeId: activeWorktreeId,
        placementWorkspaceId: scope?.placementWorkspaceId,
        initialCwd: scope ? (worktreePath ?? undefined) : undefined,
        groupId:
          (scope
            ? useAppStore.getState().activeGroupIdByWorktree[scope.placementWorkspaceId]
            : undefined) ?? activeGroupId,
        connectionId: activeConnectionId,
        repoId: activeRepo?.id,
        launchPlatform: activeSourceControlLaunchPlatform
      }
      await savedStart.start({
        selection: editor.initialSelection,
        basePrompt: resolveConflictsPrompt,
        ...editor,
        actionId: 'resolveConflicts',
        repo: activeRepo,
        promptDelivery: 'submit-after-ready',
        launchSource: 'conflict_resolution',
        signal,
        onClose: () => {},
        onLaunched: (backgroundWorkspaceId) =>
          !backgroundWorkspaceId &&
          toast.success(
            t(
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
    getLaunchActionRecipe: getCurrentLaunchActionRecipe,
    getStoreState
  })

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
