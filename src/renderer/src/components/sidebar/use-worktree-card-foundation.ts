import React, { useCallback, useEffect, useState } from 'react'

import { DEFAULT_AGENT_ACTIVITY_DISPLAY_MODE } from '../../../../shared/constants'
import {
  isRuntimeOwnedSshTargetId,
  parseExecutionHostId,
  toRuntimeExecutionHostId
} from '../../../../shared/execution-host'
import { getHostDisplayLabelOverrides } from '../../../../shared/host-setting-overrides'
import { getWorkspacePortsByWorktreeId } from '@/lib/workspace-port-groups'
import { getExplicitRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import { hydrateRuntimeEnvironmentSshState } from '@/runtime/runtime-environment-ssh-state'
import { useAppStore } from '@/store'
import {
  selectRuntimeAwareSshStatus,
  selectRuntimeAwareSshTargetLabel,
  selectRuntimeAwareSshTargetRemoved
} from '@/store/slices/runtime-environment-ssh'
import { EMPTY_WORKSPACE_PORTS, type WorktreeCardProps } from './worktree-card-model'
import { getDeleteStateForWorktreeHost } from './worktree-delete-state-host-match'

export function useWorktreeCardFoundation({
  worktree,
  repo
}: Pick<WorktreeCardProps, 'worktree' | 'repo'>) {
  const openModal = useAppStore((s) => s.openModal)
  const openTaskPage = useAppStore((s) => s.openTaskPage)
  const openAutomationsPage = useAppStore((s) => s.openAutomationsPage)
  const setPendingAutomationRunNavigation = useAppStore((s) => s.setPendingAutomationRunNavigation)
  const updateWorktreeMeta = useAppStore((s) => s.updateWorktreeMeta)
  const deleteFolderWorkspace = useAppStore((s) => s.deleteFolderWorkspace)
  const setActiveWorktree = useAppStore((s) => s.setActiveWorktree)
  const renamingWorktreeId = useAppStore((s) => s.renamingWorktreeId)
  const setRenamingWorktreeId = useAppStore((s) => s.setRenamingWorktreeId)
  const fetchHostedReviewForBranch = useAppStore((s) => s.fetchHostedReviewForBranch)
  const settings = useAppStore((s) => s.settings)
  const fetchIssue = useAppStore((s) => s.fetchIssue)
  const fetchLinearIssue = useAppStore((s) => s.fetchLinearIssue)
  const cardProps = useAppStore((s) => s.worktreeCardProperties)
  const agentActivityDisplayMode =
    useAppStore((s) => s.agentActivityDisplayMode) ?? DEFAULT_AGENT_ACTIVITY_DISPLAY_MODE
  const projectGroups = useAppStore((s) => s.projectGroups)
  const newCardStyle = settings?.experimentalNewWorktreeCardStyle === true
  const compactCards = !newCardStyle && settings?.compactWorktreeCards === true
  const handleEditIssue = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      openModal('edit-meta', {
        worktreeId: worktree.id,
        // Why: the same workspace ID can exist under two hosts. Naming the owner
        // keeps the dialog on the clicked row instead of the ambiguous lookup.
        repoId: worktree.repoId,
        currentDisplayName: worktree.displayName,
        currentIssue: worktree.linkedIssue,
        currentPR: worktree.linkedPR,
        currentComment: worktree.comment,
        focus: 'issue'
      })
    },
    [worktree, openModal]
  )

  const handleEditComment = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      openModal('edit-meta', {
        worktreeId: worktree.id,
        repoId: worktree.repoId,
        currentDisplayName: worktree.displayName,
        currentIssue: worktree.linkedIssue,
        currentPR: worktree.linkedPR,
        currentComment: worktree.comment,
        focus: 'comment'
      })
    },
    [worktree, openModal]
  )

  const handleOpenAutomation = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      const automationId = worktree.automationProvenance?.automationId
      if (!automationId) {
        return
      }
      const hostId = worktree.automationProvenance?.hostId ?? worktree.hostId
      setPendingAutomationRunNavigation({
        automationId,
        runId: null,
        ...(hostId ? { hostId } : {})
      })
      openAutomationsPage()
    },
    [
      openAutomationsPage,
      setPendingAutomationRunNavigation,
      worktree.automationProvenance?.automationId,
      worktree.automationProvenance?.hostId,
      worktree.hostId
    ]
  )

  const handleOpenAutomationRun = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      const provenance = worktree.automationProvenance
      if (!provenance) {
        return
      }
      const hostId = provenance.hostId ?? worktree.hostId
      setPendingAutomationRunNavigation({
        automationId: provenance.automationId,
        runId: provenance.automationRunId,
        ...(hostId ? { hostId } : {})
      })
      openAutomationsPage()
    },
    [
      openAutomationsPage,
      setPendingAutomationRunNavigation,
      worktree.automationProvenance,
      worktree.hostId
    ]
  )

  const deleteState = useAppStore((s) => {
    return getDeleteStateForWorktreeHost(worktree, s.deleteStateByWorktreeId)
  })
  const conflictOperation = useAppStore((s) => s.gitConflictOperationByWorktree[worktree.id])
  const remoteBranchConflict = useAppStore((s) => s.remoteBranchConflictByWorktreeId[worktree.id])
  const workspacePorts = useAppStore(
    (s) =>
      getWorkspacePortsByWorktreeId(s.workspacePortScan?.result).get(worktree.id) ??
      EMPTY_WORKSPACE_PORTS
  )

  const sshOwnerEnvironmentId = useAppStore((s) =>
    repo?.connectionId ? getExplicitRuntimeEnvironmentIdForWorktree(s, worktree.id) : null
  )
  const sshStatus = useAppStore((s) => {
    // Why: runtime-owned SSH targets suppress their ssh:state-changed broadcasts, so don't show a false "disconnected" chip for them.
    if (!repo?.connectionId || isRuntimeOwnedSshTargetId(repo.connectionId)) {
      return null
    }
    return selectRuntimeAwareSshStatus(s, sshOwnerEnvironmentId, repo.connectionId)
  })
  useEffect(() => {
    if (sshOwnerEnvironmentId) {
      void hydrateRuntimeEnvironmentSshState(sshOwnerEnvironmentId).catch(() => {})
    }
  }, [sshOwnerEnvironmentId])
  const isSshDisconnected = sshStatus != null && sshStatus !== 'connected'
  // Why: only reported on positive evidence, so a removed host never offers a Connect that can
  // only fail. Runtime-owned targets are excluded for the same reason sshStatus excludes them —
  // ssh:listTargets filters them out, so "absent from the target list" is not evidence of removal.
  const sshTargetRemoved = useAppStore((s) =>
    repo?.connectionId && !isRuntimeOwnedSshTargetId(repo.connectionId)
      ? selectRuntimeAwareSshTargetRemoved(s, sshOwnerEnvironmentId, repo.connectionId)
      : false
  )

  const parsedRepoHost = parseExecutionHostId(repo?.executionHostId)
  const runtimeOwnerEnvironmentId =
    worktree.runtimeOwnerEnvironmentId ??
    (parsedRepoHost?.kind === 'runtime' ? parsedRepoHost.environmentId : null)
  const runtimeHostId = runtimeOwnerEnvironmentId
    ? toRuntimeExecutionHostId(runtimeOwnerEnvironmentId)
    : null
  const runtimeEnvironmentName = useAppStore((s) =>
    runtimeOwnerEnvironmentId
      ? (s.runtimeEnvironments.find((environment) => environment.id === runtimeOwnerEnvironmentId)
          ?.name ?? null)
      : null
  )
  const runtimeHostLabel = runtimeHostId
    ? (getHostDisplayLabelOverrides(settings).get(runtimeHostId) ?? runtimeEnvironmentName)
    : null
  // Why: runtime ("Orca server") hosts get the same disconnected dimming as SSH when their environment has no live status.
  const isRuntimeDisconnected = useAppStore((s) => {
    if (!runtimeOwnerEnvironmentId) {
      return false
    }
    return !s.runtimeStatusByEnvironmentId.get(runtimeOwnerEnvironmentId)?.status
  })
  const [titleRenaming, setTitleRenaming] = useState(false)
  const [showRenameErrorDialog, setShowRenameErrorDialog] = useState(false)
  // Why: read the target label from its owning host's store instead of exposing HUB-private SSH metadata as client-local state.
  const sshTargetLabel = useAppStore((s) =>
    repo?.connectionId
      ? selectRuntimeAwareSshTargetLabel(s, sshOwnerEnvironmentId, repo.connectionId)
      : ''
  )

  return {
    openModal,
    openTaskPage,
    updateWorktreeMeta,
    deleteFolderWorkspace,
    setActiveWorktree,
    renamingWorktreeId,
    setRenamingWorktreeId,
    fetchHostedReviewForBranch,
    settings,
    fetchIssue,
    fetchLinearIssue,
    cardProps,
    agentActivityDisplayMode,
    projectGroups,
    newCardStyle,
    compactCards,
    handleEditIssue,
    handleEditComment,
    handleOpenAutomation,
    handleOpenAutomationRun,
    deleteState,
    conflictOperation,
    remoteBranchConflict,
    workspacePorts,
    sshOwnerEnvironmentId,
    sshStatus,
    isSshDisconnected,
    sshTargetRemoved,
    parsedRepoHost,
    runtimeHostLabel,
    isRuntimeDisconnected,
    titleRenaming,
    setTitleRenaming,
    showRenameErrorDialog,
    setShowRenameErrorDialog,
    sshTargetLabel
  }
}
