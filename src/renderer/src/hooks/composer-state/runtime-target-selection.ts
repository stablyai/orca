import type { ComposerRuntimeTargetSelectionInput } from './composer-target-input-contracts'

import { useEffect, useMemo, useRef } from 'react'
import { getFolderSourceRepos } from '@/components/sidebar/folder-workspace-composer-helpers'
import { parseExecutionHostId, getRepoExecutionHostId } from '../../../../shared/execution-host'
import { getSelectedRepoSshGate } from '@/lib/new-workspace-ssh-gate'
import { useFolderWorkspaceComposerPathStatus } from '@/components/sidebar/folder-workspace-composer-path-status'
import { useDetectedAgents } from '@/hooks/useDetectedAgents'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { resolveWorkspaceCreationTarget } from '@/lib/project-host-workspace-target'
import { isGitRepoKind } from '../../../../shared/repo-kind'
import { CLIENT_PLATFORM } from '@/lib/new-workspace'
import { getLocalRepoProjectExecutionRuntimeContext } from '@/lib/local-preflight-context'
import { getAgentLaunchPlatformForRepo } from '@/lib/agent-launch-platform'
import { repoIsRemote } from '../../../../shared/agent-launch-remote'
import { resolveLocalWindowsAgentStartupShell } from '../../../../shared/windows-terminal-shell'
import { buildProjectHostSetupOptions } from '@/lib/project-host-setup-options'
import { buildNewWorkspaceCreateTargetOptions } from '@/lib/new-workspace-project-options'
import { getSettingsForRepoRuntimeOwner } from '@/lib/repo-runtime-owner'
import { useEphemeralVmRecipeOptions } from '@/hooks/useEphemeralVmRecipeOptions'

export function useComposerRuntimeTargetSelection(input: ComposerRuntimeTargetSelectionInput) {
  const {
    actionableHostIds,
    activeRepoId,
    eligibleRepos,
    hostOptions,
    initialEphemeralVmRecipeId,
    projectGroups,
    projectHostSetups,
    projects,
    repoId,
    repos,
    selectedProjectGroup,
    selectedProjectHostSetupOverrideId,
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
        draftRepoId: repoId,
        projectHostSetupId: selectedProjectHostSetupOverrideId,
        focusedHostScope: workspaceHostScope,
        actionableHostIds
      }),
    [
      actionableHostIds,
      eligibleRepos,
      projectHostSetups,
      projects,
      repoId,
      selectedProjectHostSetupOverrideId,
      workspaceHostScope
    ]
  )

  const selectedRepo =
    selectedWorkspaceTarget.status === 'ready' && selectedWorkspaceTarget.target.repoId === repoId
      ? selectedWorkspaceTarget.target.repo
      : eligibleRepos.find((repo) => repo.id === repoId)

  const selectedRepoIsGit = selectedRepo ? isGitRepoKind(selectedRepo) : false

  const selectedRepoExecutionHostId = selectedRepo ? getRepoExecutionHostId(selectedRepo) : null

  const selectedRepoHookContextKey = selectedRepo
    ? JSON.stringify([selectedRepoExecutionHostId ?? 'local', repoId])
    : null

  const selectedRepoAgentLaunchPlatform = useMemo(() => {
    if (!selectedRepo) {
      return CLIENT_PLATFORM
    }
    const projectRuntime = selectedRepo.connectionId
      ? undefined
      : getLocalRepoProjectExecutionRuntimeContext(
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
    return getAgentLaunchPlatformForRepo(selectedRepo, projectRuntime)
  }, [activeRepoId, projects, repos, selectedRepo, settings, worktreesByRepo])

  // Why: SSH remotes deploy the CLI shim as plain `orca`, so the Linux-only `orca-ide` rename must not apply to remote launch commands.
  const selectedRepoIsRemote = selectedRepo ? repoIsRemote(selectedRepo) : false

  const selectedRepoStartupShell = resolveLocalWindowsAgentStartupShell({
    platform: selectedRepoAgentLaunchPlatform,
    isRemote: selectedRepoIsRemote,
    terminalWindowsShell: settings?.terminalWindowsShell
  })

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

  const selectedRepoSettings = useMemo(() => {
    if (!settings) {
      return settings
    }
    // Why: probes and attachment uploads inspect the selected repo, even though creation defaults still follow host scope.
    return getSettingsForRepoRuntimeOwner(
      { repos: selectedRepo ? [selectedRepo] : [], settings },
      selectedRepo?.id ?? null
    )
  }, [selectedRepo, settings])

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

  const selectedRepoConnectionId = selectedRepo?.connectionId ?? null

  const selectedRepoSshState = selectedRepoConnectionId
    ? (sshConnectionStates.get(selectedRepoConnectionId) ?? null)
    : null

  const { selectedRepoSshStatus, selectedRepoRequiresConnection, selectedRepoConnectInProgress } =
    getSelectedRepoSshGate({
      connectionId: selectedRepoConnectionId,
      status: selectedRepoSshState?.status ?? null
    })

  const repoIdRef = useRef(repoId)

  useEffect(() => {
    repoIdRef.current = repoId
  }, [repoId])

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
    selectedRepo,
    selectedRepoIsGit,
    selectedRepoExecutionHostId,
    selectedRepoHookContextKey,
    selectedRepoAgentLaunchPlatform,
    selectedRepoIsRemote,
    selectedRepoStartupShell,
    selectedRepoProjectId,
    selectedProjectId,
    selectedProjectHostSetupId,
    projectHostSetupOptions,
    projectOptions,
    selectedRepoSettings,
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
