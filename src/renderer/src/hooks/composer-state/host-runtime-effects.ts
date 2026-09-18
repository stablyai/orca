import type { ComposerModel } from './composer-model'

type HostRuntimeEffectsInput = Pick<
  ComposerModel,
  | 'commitHookCheckIfCurrent'
  | 'connectionId'
  | 'createGateMode'
  | 'disabledTuiAgents'
  | 'enableIssueAutomation'
  | 'ensureDetectedAgents'
  | 'ensureRemoteDetectedAgents'
  | 'ensureRuntimeDetectedAgents'
  | 'fallbackDefaultAgent'
  | 'folderTargetConnectionId'
  | 'isRemote'
  | 'loadHookCheckForRepo'
  | 'newWorkspaceDraft'
  | 'repoId'
  | 'repoIdRef'
  | 'runtimeEnvironmentId'
  | 'selectedRepoConnectionIdRef'
  | 'selectedRepoExecutionHostId'
  | 'selectedRepoHookContextKey'
  | 'selectedRepoIsGit'
  | 'selectedRepoSettingsRef'
  | 'selectedRepoSshStatus'
  | 'setLoadedRepoCommand'
  | 'setTuiAgent'
  | 'settings'
  | 'tuiAgent'
>

import { useEffect, useCallback } from 'react'
import type { IssueCommandReadResult } from '@/runtime/runtime-hooks-client'
import { filterEnabledTuiAgents, isTuiAgentEnabled } from '../../../../shared/tui-agent-selection'
import { getAgentCatalog } from '@/lib/agent-catalog'
import { readRuntimeIssueCommand } from '@/runtime/runtime-hooks-client'
import { useAppStore } from '@/store'
import { isSshConnectInProgress } from '@/lib/new-workspace-ssh-gate'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'

const ERRORED_REPO_COMMAND_READ: IssueCommandReadResult = {
  status: 'error',
  localContent: null,
  sharedContent: null,
  effectiveContent: null,
  localFilePath: '',
  source: 'none'
}

export function useHostRuntimeEffects(input: HostRuntimeEffectsInput) {
  const {
    commitHookCheckIfCurrent,
    connectionId,
    createGateMode,
    disabledTuiAgents,
    enableIssueAutomation,
    ensureDetectedAgents,
    ensureRemoteDetectedAgents,
    ensureRuntimeDetectedAgents,
    fallbackDefaultAgent,
    folderTargetConnectionId,
    isRemote,
    loadHookCheckForRepo,
    newWorkspaceDraft,
    repoId,
    repoIdRef,
    runtimeEnvironmentId,
    selectedRepoConnectionIdRef,
    selectedRepoExecutionHostId,
    selectedRepoHookContextKey,
    selectedRepoIsGit,
    selectedRepoSettingsRef,
    selectedRepoSshStatus,
    setLoadedRepoCommand,
    setTuiAgent,
    settings,
    tuiAgent
  } = input

  // Why: re-detect agents when the selected repo changes so the list matches the correct host (local runs once, deduped by the store).
  useEffect(() => {
    if (isRemote && selectedRepoSshStatus !== 'connected') {
      return
    }
    let cancelled = false
    const detect = isRemote
      ? ensureRemoteDetectedAgents(connectionId!)
      : runtimeEnvironmentId
        ? ensureRuntimeDetectedAgents(runtimeEnvironmentId)
        : ensureDetectedAgents()
    void detect.then((ids) => {
      if (cancelled) {
        return
      }
      const enabledIds = filterEnabledTuiAgents(ids, disabledTuiAgents)
      if (!newWorkspaceDraft?.agent && !settings?.defaultTuiAgent && enabledIds.length > 0) {
        const firstInCatalogOrder = getAgentCatalog().find((a) => enabledIds.includes(a.id))
        if (firstInCatalogOrder) {
          setTuiAgent(firstInCatalogOrder.id)
        }
      } else if (!isTuiAgentEnabled(tuiAgent, disabledTuiAgents)) {
        const firstEnabledDetected = getAgentCatalog().find((a) => enabledIds.includes(a.id))
        setTuiAgent(firstEnabledDetected?.id ?? fallbackDefaultAgent)
      }
    })
    return () => {
      cancelled = true
    }
    // Why: deps narrowed to host identity (connectionId/runtimeEnvironmentId); detection is a best-effort PATH snapshot, so draft/settings are excluded.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    connectionId,
    runtimeEnvironmentId,
    isRemote,
    selectedRepoSshStatus,
    disabledTuiAgents,
    setTuiAgent
  ])

  // Per-repo: load yaml hooks + issue command template.
  useEffect(() => {
    if (!repoId || !selectedRepoIsGit || !selectedRepoHookContextKey) {
      return
    }

    let cancelled = false

    void loadHookCheckForRepo(repoId)
      .then((result) => {
        if (!cancelled) {
          commitHookCheckIfCurrent(selectedRepoHookContextKey, result.hooks)
        }
      })
      .catch(() => {
        if (!cancelled) {
          commitHookCheckIfCurrent(selectedRepoHookContextKey, null)
        }
      })

    if (!enableIssueAutomation) {
      return () => {
        cancelled = true
      }
    }

    if (createGateMode === 'quick') {
      return () => {
        cancelled = true
      }
    }

    void Promise.all([
      readRuntimeIssueCommand(
        selectedRepoSettingsRef.current,
        repoId,
        selectedRepoExecutionHostId ?? undefined,
        'issue'
      ).catch(() => ERRORED_REPO_COMMAND_READ),
      // Why: a pre-review-template host has no such method; an errored read leaves the built-in
      // default in play, exactly as a failed issue read does today.
      readRuntimeIssueCommand(
        selectedRepoSettingsRef.current,
        repoId,
        selectedRepoExecutionHostId ?? undefined,
        'review'
      ).catch(() => ERRORED_REPO_COMMAND_READ)
    ]).then(([issue, review]) => {
      if (cancelled) {
        return
      }
      setLoadedRepoCommand(selectedRepoHookContextKey, 'issue', issue)
      setLoadedRepoCommand(selectedRepoHookContextKey, 'review', review)
    })

    return () => {
      cancelled = true
    }
  }, [
    commitHookCheckIfCurrent,
    createGateMode,
    enableIssueAutomation,
    loadHookCheckForRepo,
    repoId,
    selectedRepoExecutionHostId,
    selectedRepoHookContextKey,
    selectedRepoIsGit,
    runtimeEnvironmentId,
    selectedRepoSettingsRef,
    setLoadedRepoCommand
  ])

  const onConnectSelectedRepo = useCallback(async (): Promise<void> => {
    const targetId = selectedRepoConnectionIdRef.current
    if (!targetId) {
      return
    }
    const liveState = useAppStore.getState()
    const liveRepo = liveState.repos.find((repo) => repo.id === repoIdRef.current)
    if (liveRepo?.connectionId !== targetId) {
      return
    }
    const liveStatus = liveState.sshConnectionStates.get(targetId)?.status ?? null
    if (liveStatus === 'connected' || isSshConnectInProgress(liveStatus)) {
      return
    }

    try {
      await window.api.ssh.connect({ targetId })
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : translate('auto.hooks.useComposerState.ba6cb77082', 'Failed to connect to project.')
      )
    }
  }, [repoIdRef, selectedRepoConnectionIdRef])

  const onConnectSelectedProjectGroup = useCallback(async (): Promise<void> => {
    if (!folderTargetConnectionId) {
      return
    }
    const liveStatus = useAppStore
      .getState()
      .sshConnectionStates.get(folderTargetConnectionId)?.status
    if (liveStatus === 'connected' || isSshConnectInProgress(liveStatus ?? null)) {
      return
    }
    try {
      await window.api.ssh.connect({ targetId: folderTargetConnectionId })
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : translate('auto.hooks.useComposerState.ba6cb77082', 'Failed to connect to project.')
      )
    }
  }, [folderTargetConnectionId])

  return {
    onConnectSelectedRepo,
    onConnectSelectedProjectGroup
  }
}
