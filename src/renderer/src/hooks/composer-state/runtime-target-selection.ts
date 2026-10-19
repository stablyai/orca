import { ipcOrRuntimeTargetForHostId } from '@/runtime/runtime-client-target'
import type { ComposerRuntimeTargetSelectionInput } from './composer-target-input-contracts'

import { useEffect, useMemo, useRef } from 'react'
import { getFolderSourceRepos } from '@/components/sidebar/folder-workspace-composer-helpers'
import { parseExecutionHostId, getRepoExecutionHostId } from '../../../../shared/execution-host'
import { getSelectedRepoSshGate } from '@/lib/new-workspace-ssh-gate'
import { selectRepoSshGateInput } from '@/lib/repo-ssh-connection'
import { useFolderWorkspaceComposerPathStatus } from '@/components/sidebar/folder-workspace-composer-path-status'
import { useDetectedAgents } from '@/hooks/useDetectedAgents'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { resolveWorkspaceCreationTarget } from '@/lib/project-host-workspace-target'
import { isGitRepoKind } from '../../../../shared/repo-kind'
import { CLIENT_PLATFORM } from '@/lib/new-workspace'
import { getLocalRepoProjectExecutionRuntimeContext } from '@/lib/local-preflight-context'
import {
  resolveExecutionHostAgentStartupShell,
  resolveRepoExecutionHostPlatform,
  type ExecutionHostPlatformFact
} from '@/lib/execution-host-facts'
import { useAppStore } from '@/store'
import { repoIsRemote } from '../../../../shared/agent-launch-remote'
import { buildProjectHostSetupOptions } from '@/lib/project-host-setup-options'
import { buildNewWorkspaceCreateTargetOptions } from '@/lib/new-workspace-project-options'
import { getRuntimeEnvironmentIdForRepo } from '@/lib/repo-runtime-owner'
import { useEphemeralVmRecipeOptions } from '@/hooks/useEphemeralVmRecipeOptions'

export function useComposerRuntimeTargetSelection(input: ComposerRuntimeTargetSelectionInput) {
  const {
    actionableHostIds,
    activeRepoId,
    eligibleRepos,
    hostOptions,
    initialEphemeralVmRecipeId,
    pendingInitialWorkspaceTarget,
    projectGroups,
    projectHostSetups,
    projects,
    repoId: requestedRepoId,
    repos,
    selectedProjectGroup,
    selectedProjectHostSetupOverrideId,
    selectedProjectHostSetupOverrideHostId,
    settings,
    sshConnectionStates,
    workspaceHostScope,
    worktreesByRepo
  } = input

  const isProjectGroupTarget = selectedProjectGroup !== null

  const folderSourceRepos = useMemo(
    () => getFolderSourceRepos(repos, projectGroups, selectedProjectGroup),
    [projectGroups, repos, selectedProjectGroup]
  )

  const parsedFolderTargetHost = parseExecutionHostId(selectedProjectGroup?.executionHostId)

  const folderTargetRuntimeEnvironmentId =
    parsedFolderTargetHost?.kind === 'runtime' ? parsedFolderTargetHost.environmentId : null

  const folderTargetConnectionId =
    parsedFolderTargetHost?.kind === 'runtime' ? null : (selectedProjectGroup?.connectionId ?? null)

  const folderTargetIsRemote =
    folderTargetConnectionId !== null || folderTargetRuntimeEnvironmentId !== null

  const folderTargetAgentDetectionTarget = folderTargetRuntimeEnvironmentId
    ? { kind: 'runtime' as const, environmentId: folderTargetRuntimeEnvironmentId }
    : folderTargetConnectionId
      ? { kind: 'ssh' as const, connectionId: folderTargetConnectionId }
      : selectedProjectGroup
        ? { kind: 'local' as const }
        : undefined

  const folderTargetSshState = folderTargetConnectionId
    ? (sshConnectionStates.get(folderTargetConnectionId) ?? null)
    : null

  const {
    selectedRepoSshStatus: folderTargetSshStatus,
    selectedRepoRequiresConnection: folderTargetRequiresConnection,
    selectedRepoConnectInProgress: folderTargetConnectInProgress
  } = getSelectedRepoSshGate({
    connectionId: folderTargetConnectionId,
    status: folderTargetSshState?.status ?? null
  })

  const { pathStatusBlocksCreate: folderPathStatusBlocksCreate, pathStatusProjectError } =
    useFolderWorkspaceComposerPathStatus(
      selectedProjectGroup,
      true,
      folderTargetRuntimeEnvironmentId
    )

  const { detectedIds: folderDetectedIds } = useDetectedAgents(folderTargetAgentDetectionTarget)

  const folderDetectedAgentIds = useMemo<Set<TuiAgent> | null>(
    () => (folderDetectedIds ? new Set(folderDetectedIds) : null),
    [folderDetectedIds]
  )

  const selectedWorkspaceTarget = useMemo(
    () =>
      resolveWorkspaceCreationTarget({
        eligibleRepos,
        projects,
        projectHostSetups,
        draftRepoId: requestedRepoId,
        projectId: pendingInitialWorkspaceTarget?.projectId,
        hostId: pendingInitialWorkspaceTarget?.hostId,
        projectHostSetupId:
          pendingInitialWorkspaceTarget?.projectHostSetupId ?? selectedProjectHostSetupOverrideId,
        projectHostSetupHostId:
          pendingInitialWorkspaceTarget?.hostId ??
          (selectedProjectHostSetupOverrideId ? selectedProjectHostSetupOverrideHostId : null),
        focusedHostScope: workspaceHostScope,
        actionableHostIds
      }),
    [
      actionableHostIds,
      eligibleRepos,
      pendingInitialWorkspaceTarget,
      projectHostSetups,
      projects,
      requestedRepoId,
      selectedProjectHostSetupOverrideId,
      selectedProjectHostSetupOverrideHostId,
      workspaceHostScope
    ]
  )

  const resolvedRepoId =
    !isProjectGroupTarget &&
    pendingInitialWorkspaceTarget &&
    selectedWorkspaceTarget.status === 'ready'
      ? selectedWorkspaceTarget.target.repoId
      : requestedRepoId

  const selectedRepo = isProjectGroupTarget
    ? eligibleRepos.find((repo) => repo.id === resolvedRepoId)
    : selectedWorkspaceTarget.status === 'ready' &&
        selectedWorkspaceTarget.target.repoId === resolvedRepoId
      ? selectedWorkspaceTarget.target.repo
      : undefined

  const selectedRepoIsGit = selectedRepo ? isGitRepoKind(selectedRepo) : false

  const selectedRepoExecutionHostId = selectedRepo ? getRepoExecutionHostId(selectedRepo) : null

  const selectedRepoHookContextKey = selectedRepo
    ? JSON.stringify([selectedRepoExecutionHostId ?? 'local', resolvedRepoId])
    : null

  const sshStateByEnvironment = useAppStore((s) => s.sshStateByEnvironment)
  const runtimeStatusByEnvironmentId = useAppStore((s) => s.runtimeStatusByEnvironmentId)
  // Why: the agent runs on the repo's execution host, so its OS decides quoting, not this client's (#22204).
  const selectedRepoAgentLaunchFact = useMemo((): ExecutionHostPlatformFact => {
    if (!selectedRepo) {
      return { kind: 'withheld', reason: 'Select a project first.' }
    }
    return resolveRepoExecutionHostPlatform(
      { sshConnectionStates, sshStateByEnvironment, runtimeStatusByEnvironmentId },
      selectedRepo,
      () =>
        getLocalRepoProjectExecutionRuntimeContext(
          {
            activeRepoId,
            activeWorktreeId: null,
            projects,
            repos,
            settings,
            worktreesByRepo
          },
          selectedRepo.id,
          CLIENT_PLATFORM
        )
    )
  }, [
    activeRepoId,
    projects,
    repos,
    runtimeStatusByEnvironmentId,
    selectedRepo,
    settings,
    sshConnectionStates,
    sshStateByEnvironment,
    worktreesByRepo
  ])

  // Why: SSH remotes deploy the CLI shim as plain `orca`, so the Linux-only `orca-ide` rename must not apply to remote launch commands.
  const selectedRepoIsRemote = selectedRepo ? repoIsRemote(selectedRepo) : false

  const selectedRepoStartupShell = resolveExecutionHostAgentStartupShell(
    selectedRepoAgentLaunchFact,
    settings?.terminalWindowsShell
  )

  const selectedRepoProjectId =
    selectedWorkspaceTarget.status === 'ready' ? selectedWorkspaceTarget.target.projectId : null

  const selectedProjectId = selectedProjectGroup
    ? `project-group:${selectedProjectGroup.id}`
    : selectedRepoProjectId

  const selectedProjectHostSetupId =
    !selectedProjectGroup && selectedWorkspaceTarget.status === 'ready'
      ? selectedWorkspaceTarget.target.projectHostSetupId
      : null

  const projectHostSetupOptions = useMemo(
    () =>
      buildProjectHostSetupOptions({
        projectId: selectedRepoProjectId,
        projectHostSetups,
        eligibleRepos,
        hosts: hostOptions
      }),
    [eligibleRepos, hostOptions, projectHostSetups, selectedRepoProjectId]
  )

  const projectOptions = useMemo(
    () =>
      buildNewWorkspaceCreateTargetOptions({
        projects,
        projectHostSetups,
        eligibleRepos,
        projectGroups,
        hosts: hostOptions
      }),
    [eligibleRepos, hostOptions, projectGroups, projectHostSetups, projects]
  )

  // Why: probes and attachment uploads inspect the selected repo, even though creation defaults still follow host scope.
  const selectedRepoRuntimeEnvironmentId = settings
    ? getRuntimeEnvironmentIdForRepo(
        { repos: selectedRepo ? [selectedRepo] : [], settings },
        selectedRepo?.id ?? null
      )
    : null

  const selectedRepoTarget = useMemo(
    () => (selectedRepo ? ipcOrRuntimeTargetForHostId(getRepoExecutionHostId(selectedRepo)) : null),
    [selectedRepo]
  )

  // Why: key on repo id, not the repo object — updateRepo replaces it by reference and would re-run this effect, wiping the user's chosen recipe.
  const selectedRecipeRepoId = selectedRepo?.id ?? null

  const selectedRecipeRepoConnectionId = selectedRepo?.connectionId ?? null

  // Why: gate recipe probing on the experimental toggle, since discovery can surface setup errors for a hidden feature.
  const ephemeralVmsEnabled = settings?.experimentalEphemeralVms === true

  const {
    recipes: ephemeralVmRecipes,
    selectedRecipeId: selectedEphemeralVmRecipeId,
    setSelectedRecipeId: setSelectedEphemeralVmRecipeId,
    error: ephemeralVmRecipeError
  } = useEphemeralVmRecipeOptions({
    enabled: ephemeralVmsEnabled,
    repoId: selectedRecipeRepoId,
    repoIsGit: selectedRepoIsGit,
    repoConnectionId: selectedRecipeRepoConnectionId,
    repoExecutionHostId: selectedRepo ? getRepoExecutionHostId(selectedRepo) : null,
    projectGroupTarget: isProjectGroupTarget,
    initialRecipeId: initialEphemeralVmRecipeId
  })

  // Why the shared gate: a paired server's own SSH target is read from that server (#25887).
  const selectedRepoSshGateInput = selectedRepo
    ? selectRepoSshGateInput(
        { sshConnectionStates, sshStateByEnvironment, runtimeStatusByEnvironmentId },
        selectedRepo
      )
    : null
  const selectedRepoConnectionId = selectedRepoSshGateInput?.connectionId ?? null
  const selectedRepoSshState = selectedRepoConnectionId
    ? (sshConnectionStates.get(selectedRepoConnectionId) ?? null)
    : null

  const { selectedRepoSshStatus, selectedRepoRequiresConnection, selectedRepoConnectInProgress } =
    getSelectedRepoSshGate({
      connectionId: selectedRepoConnectionId,
      status: selectedRepoSshGateInput?.status ?? null
    })

  const repoIdRef = useRef(resolvedRepoId)

  useEffect(() => {
    repoIdRef.current = resolvedRepoId
  }, [resolvedRepoId])

  return {
    isProjectGroupTarget,
    folderSourceRepos,
    parsedFolderTargetHost,
    folderTargetRuntimeEnvironmentId,
    folderTargetConnectionId,
    folderTargetIsRemote,
    folderTargetAgentDetectionTarget,
    folderTargetSshState,
    folderTargetSshStatus,
    folderTargetRequiresConnection,
    folderTargetConnectInProgress,
    folderPathStatusBlocksCreate,
    pathStatusProjectError,
    folderDetectedIds,
    folderDetectedAgentIds,
    selectedWorkspaceTarget,
    resolvedRepoId,
    selectedRepo,
    selectedRepoIsGit,
    selectedRepoExecutionHostId,
    selectedRepoHookContextKey,
    selectedRepoAgentLaunchFact,
    selectedRepoIsRemote,
    selectedRepoStartupShell,
    selectedRepoProjectId,
    selectedProjectId,
    selectedProjectHostSetupId,
    projectHostSetupOptions,
    projectOptions,
    selectedRepoRuntimeEnvironmentId,
    selectedRepoTarget,
    selectedRecipeRepoId,
    selectedRecipeRepoConnectionId,
    ephemeralVmsEnabled,
    ephemeralVmRecipes,
    selectedEphemeralVmRecipeId,
    setSelectedEphemeralVmRecipeId,
    ephemeralVmRecipeError,
    selectedRepoConnectionId,
    selectedRepoSshState,
    selectedRepoSshStatus,
    selectedRepoRequiresConnection,
    selectedRepoConnectInProgress,
    repoIdRef
  }
}
