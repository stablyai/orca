/* eslint-disable max-lines -- Why: the add-project dialog centralizes step routing, clone/remote/create state, and reset semantics across five steps so the modal flow stays in one place. */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { FolderOpen, ArrowLeft, Globe, Monitor, FolderTree, Lightbulb } from 'lucide-react'
import { useAppStore } from '@/store'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { NestedRepoTreePreview } from '@/components/repo/NestedRepoTreePreview'
import { track } from '@/lib/telemetry'
import { RemoteStep, CloneStep, useRemoteRepo } from './AddRepoSteps'
import { CreateStep, useCreateRepo } from './AddRepoCreateStep'
import { getProjectAddedPrimaryBranchName, SetupStep } from './AddRepoSetupStep'
import { getDefaultCloneParent } from './clone-defaults'
import { callRuntimeRpc, getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { isGitRepoKind } from '../../../../shared/repo-kind'
import {
  buildNestedRepoImportActionTelemetry,
  buildNestedRepoImportResultTelemetry,
  buildNestedRepoScanTelemetry,
  createNestedRepoTelemetryAttemptId,
  shouldEmitNestedRepoImportSubmitTelemetry,
  type NestedRepoTelemetryRuntimeKind
} from '../../../../shared/nested-repo-telemetry'
import type {
  AddRepoExistingWorkspaceSource,
  AddRepoSetupStepAction
} from '../../../../shared/telemetry-events'
import type { NestedRepoScanResult, Repo } from '../../../../shared/types'
import { finalizeImportedRepoAfterSkip } from './add-repo-skip-finalization'
import {
  buildAddRepoExistingWorkspacesTelemetry,
  shouldTrackAddRepoExistingWorkspacesDetected
} from './add-repo-existing-workspaces-telemetry'
import {
  effectiveExternalWorktreeVisibility,
  isLegacyRepoForExternalWorktreeVisibility
} from '../../../../shared/worktree-ownership'

function defaultProjectGroupNameForPath(path: string): string {
  return (
    path
      .replace(/[\\/]+$/g, '')
      .split(/[\\/]/)
      .filter(Boolean)
      .at(-1) ?? path
  )
}

const AddRepoDialog = React.memo(function AddRepoDialog() {
  const activeModal = useAppStore((s) => s.activeModal)
  const modalData = useAppStore((s) => s.modalData)
  const closeModal = useAppStore((s) => s.closeModal)
  const addRepoPath = useAppStore((s) => s.addRepoPath)
  const scanNestedRepos = useAppStore((s) => s.scanNestedRepos)
  const importNestedRepos = useAppStore((s) => s.importNestedRepos)
  const updateRepo = useAppStore((s) => s.updateRepo)
  const repos = useAppStore((s) => s.repos)
  const worktreesByRepo = useAppStore((s) => s.worktreesByRepo)
  const detectedWorktreesByRepo = useAppStore((s) => s.detectedWorktreesByRepo)
  const fetchWorktrees = useAppStore((s) => s.fetchWorktrees)
  const openModal = useAppStore((s) => s.openModal)
  const openSettingsPage = useAppStore((s) => s.openSettingsPage)
  const openSettingsTarget = useAppStore((s) => s.openSettingsTarget)
  const setHideDefaultBranchWorkspace = useAppStore((s) => s.setHideDefaultBranchWorkspace)
  const settings = useAppStore((s) => s.settings)

  const [step, setStep] = useState<'add' | 'clone' | 'remote' | 'create' | 'nested' | 'setup'>(
    'add'
  )
  const [addedRepo, setAddedRepo] = useState<Repo | null>(null)
  const [existingWorkspaceSource, setExistingWorkspaceSource] =
    useState<AddRepoExistingWorkspaceSource | null>(null)
  const [isAdding, setIsAdding] = useState(false)
  const [serverPath, setServerPath] = useState('')
  const [isAddingServerPath, setIsAddingServerPath] = useState(false)
  const [cloneUrl, setCloneUrl] = useState('')
  const [cloneDestination, setCloneDestination] = useState('')
  const [isCloning, setIsCloning] = useState(false)
  const [cloneError, setCloneError] = useState<string | null>(null)
  const [cloneProgress, setCloneProgress] = useState<{ phase: string; percent: number } | null>(
    null
  )
  const [nestedScan, setNestedScan] = useState<NestedRepoScanResult | null>(null)
  const [nestedSelectedPaths, setNestedSelectedPaths] = useState<Set<string>>(new Set())
  const [nestedGroupName, setNestedGroupName] = useState('')
  const [nestedConnectionId, setNestedConnectionId] = useState<string | null>(null)
  const [nestedAttemptId, setNestedAttemptId] = useState<string | null>(null)
  const [nestedRuntimeKind, setNestedRuntimeKind] = useState<NestedRepoTelemetryRuntimeKind | null>(
    null
  )

  const getNestedRepoRuntimeKind = useCallback(
    (connectionId: string | null): NestedRepoTelemetryRuntimeKind => {
      if (connectionId) {
        return 'ssh'
      }
      return settings?.activeRuntimeEnvironmentId?.trim() ? 'runtime' : 'local'
    },
    [settings?.activeRuntimeEnvironmentId]
  )

  // Why: monotonic ID so stale clone callbacks can detect they were superseded.
  const cloneGenRef = useRef(0)
  // Why: local folder picking/scanning can outlive the dialog; resetState
  // invalidates stale continuations before they can repopulate closed UI.
  const localAddGenRef = useRef(0)
  // Why: a dropped path is modal data, so ordinary state updates must not
  // re-run the import while the Add Project dialog advances through steps.
  const droppedLocalPathHandledRef = useRef<string | null>(null)
  // Why: track whether we've already auto-filled for this entry into the clone step,
  // so a late settings hydration still gets a chance to set the default.
  const cloneStepAutoFilledRef = useRef(false)

  const {
    sshTargets,
    selectedTargetId,
    remotePath,
    remoteError,
    isAddingRemote,
    setSelectedTargetId,
    setRemotePath,
    setRemoteError,
    resetRemoteState,
    handleOpenRemoteStep,
    handleAddRemoteRepo,
    handleConnectTarget
  } = useRemoteRepo(
    fetchWorktrees,
    setStep,
    setAddedRepo,
    closeModal,
    setExistingWorkspaceSource,
    scanNestedRepos,
    (scan, selectedPath, connectionId, attemptId) => {
      setNestedScan(scan)
      setNestedSelectedPaths(new Set(scan.repos.map((repo) => repo.path)))
      setNestedGroupName(defaultProjectGroupNameForPath(scan.selectedPath || selectedPath))
      setNestedConnectionId(connectionId)
      setNestedAttemptId(attemptId)
      setNestedRuntimeKind('ssh')
      setStep('nested')
    },
    (scan, attemptId) => {
      track(
        'add_repo_nested_scan_result',
        buildNestedRepoScanTelemetry({
          attemptId,
          surface: 'sidebar',
          runtimeKind: 'ssh',
          scan
        })
      )
    }
  )

  const {
    createName,
    createParent,
    createKind,
    createError,
    isCreating,
    setCreateName,
    setCreateParent,
    setCreateKind,
    setCreateError,
    resetCreateState,
    handlePickParent,
    handleCreate
  } = useCreateRepo(fetchWorktrees, setStep, setAddedRepo, closeModal, setExistingWorkspaceSource)
  useEffect(() => {
    if (!isCloning) {
      return
    }
    return window.api.repos.onCloneProgress(setCloneProgress)
  }, [isCloning])

  useEffect(() => {
    if (step !== 'clone') {
      cloneStepAutoFilledRef.current = false
      return
    }
    if (cloneStepAutoFilledRef.current) {
      return
    }
    if (cloneDestination) {
      return
    }
    if (settings?.activeRuntimeEnvironmentId?.trim()) {
      return
    }
    if (!settings?.workspaceDir) {
      return
    }
    cloneStepAutoFilledRef.current = true
    setCloneDestination(getDefaultCloneParent(settings.workspaceDir))
  }, [step, cloneDestination, settings?.activeRuntimeEnvironmentId, settings?.workspaceDir])

  const isOpen = activeModal === 'add-repo'
  const droppedLocalPath =
    typeof modalData.droppedLocalPath === 'string' ? modalData.droppedLocalPath : ''
  const projectId = addedRepo?.id ?? ''
  const isRuntimeEnvironmentActive = Boolean(settings?.activeRuntimeEnvironmentId?.trim())

  const worktrees = useMemo(() => {
    return worktreesByRepo[projectId] ?? []
  }, [worktreesByRepo, projectId])
  const detectedResult = projectId ? detectedWorktreesByRepo[projectId] : undefined
  const hiddenWorktreeCount =
    detectedResult?.authoritative === true
      ? detectedResult.worktrees.filter(
          (worktree) => !worktree.selectedCheckout && worktree.ownership !== 'orca-managed'
        ).length
      : 0
  const otherWorktreesVisible = addedRepo
    ? effectiveExternalWorktreeVisibility(
        addedRepo,
        isLegacyRepoForExternalWorktreeVisibility(addedRepo)
      ) === 'show'
    : false

  // Why: sort by recent activity with alphabetical fallback.
  const sortedWorktrees = useMemo(() => {
    return [...worktrees].sort((a, b) => {
      if (a.lastActivityAt !== b.lastActivityAt) {
        return b.lastActivityAt - a.lastActivityAt
      }
      return a.displayName.localeCompare(b.displayName)
    })
  }, [worktrees])
  const primaryWorktree = useMemo(
    () => sortedWorktrees.find((worktree) => worktree.isMainWorktree) ?? null,
    [sortedWorktrees]
  )
  const primaryBranchName = getProjectAddedPrimaryBranchName(primaryWorktree)

  const resetState = useCallback(() => {
    cloneGenRef.current++
    localAddGenRef.current++
    // Why: kill the git clone process if one is running, so backing out
    // or closing the dialog doesn't leave a clone running on disk.
    void window.api.repos.cloneAbort()
    setStep('add')
    setAddedRepo(null)
    setExistingWorkspaceSource(null)
    setIsAdding(false)
    setServerPath('')
    setIsAddingServerPath(false)
    setCloneUrl('')
    setCloneDestination('')
    setIsCloning(false)
    setCloneError(null)
    setCloneProgress(null)
    setNestedScan(null)
    setNestedSelectedPaths(new Set())
    setNestedGroupName('')
    setNestedConnectionId(null)
    setNestedAttemptId(null)
    setNestedRuntimeKind(null)
    resetCreateState()
    resetRemoteState()
  }, [resetRemoteState, resetCreateState])

  // Why: reset state on close so reopening doesn't show stale step/repo.
  useEffect(() => {
    if (!isOpen) {
      droppedLocalPathHandledRef.current = null
      resetState()
    }
  }, [isOpen, resetState])

  const isInputStep =
    step === 'add' ||
    step === 'clone' ||
    step === 'remote' ||
    step === 'create' ||
    step === 'nested'

  const handleAddLocalPath = useCallback(
    async (path: string, source: AddRepoExistingWorkspaceSource) => {
      if (settings?.activeRuntimeEnvironmentId?.trim()) {
        toast.error('Use a server path to add projects from a remote runtime.')
        closeModal()
        return
      }
      const gen = ++localAddGenRef.current
      setIsAdding(true)
      try {
        const attemptId = createNestedRepoTelemetryAttemptId()
        const scan = await scanNestedRepos(path)
        if (gen !== localAddGenRef.current) {
          return
        }
        track(
          'add_repo_nested_scan_result',
          buildNestedRepoScanTelemetry({
            attemptId,
            surface: 'sidebar',
            runtimeKind: 'local',
            scan
          })
        )
        if (scan?.selectedPathKind === 'non_git_folder' && scan.repos.length > 0) {
          setNestedScan(scan)
          setNestedSelectedPaths(new Set(scan.repos.map((repo) => repo.path)))
          setNestedGroupName(defaultProjectGroupNameForPath(path))
          setNestedConnectionId(null)
          setNestedAttemptId(attemptId)
          setNestedRuntimeKind('local')
          setStep('nested')
          return
        }
        const repo = await addRepoPath(path)
        if (gen !== localAddGenRef.current) {
          return
        }
        if (repo && isGitRepoKind(repo)) {
          setAddedRepo(repo)
          setExistingWorkspaceSource(source)
          await fetchWorktrees(repo.id)
          if (gen !== localAddGenRef.current) {
            return
          }
          setStep('setup')
        } else if (repo) {
          // Why: folder repos skip the Git worktree setup step and activate
          // their synthetic root workspace in the folder add flow.
          closeModal()
        }
      } finally {
        if (gen === localAddGenRef.current) {
          setIsAdding(false)
        }
      }
    },
    [addRepoPath, closeModal, fetchWorktrees, scanNestedRepos, settings?.activeRuntimeEnvironmentId]
  )

  useEffect(() => {
    if (!isOpen || !droppedLocalPath) {
      return
    }
    if (droppedLocalPathHandledRef.current === droppedLocalPath) {
      return
    }
    droppedLocalPathHandledRef.current = droppedLocalPath
    void handleAddLocalPath(droppedLocalPath, 'local_folder_picker')
  }, [droppedLocalPath, handleAddLocalPath, isOpen])

  const handleBrowse = useCallback(async () => {
    const gen = ++localAddGenRef.current
    setIsAdding(true)
    try {
      const path = await window.api.repos.pickFolder()
      if (!path || gen !== localAddGenRef.current) {
        return
      }
      await handleAddLocalPath(path, 'local_folder_picker')
    } finally {
      if (gen === localAddGenRef.current) {
        setIsAdding(false)
      }
    }
  }, [handleAddLocalPath])

  const handleImportNestedRepos = useCallback(
    async (mode: 'group' | 'separate') => {
      const attemptId = nestedAttemptId
      if (
        !nestedScan ||
        !attemptId ||
        !shouldEmitNestedRepoImportSubmitTelemetry({
          attemptId,
          selectedCount: nestedSelectedPaths.size
        })
      ) {
        return
      }
      const foundCount = nestedScan.repos.length
      const selectedCount = nestedSelectedPaths.size
      const runtimeKind = nestedRuntimeKind ?? getNestedRepoRuntimeKind(nestedConnectionId)
      setIsAdding(true)
      track(
        'add_repo_nested_import_action',
        buildNestedRepoImportActionTelemetry({
          attemptId,
          surface: 'sidebar',
          runtimeKind,
          action: mode === 'group' ? 'import_group' : 'import_separate',
          foundCount,
          selectedCount
        })
      )
      let resultTracked = false
      try {
        const result = await importNestedRepos({
          parentPath: nestedScan.selectedPath,
          groupName: nestedGroupName,
          projectPaths: [...nestedSelectedPaths],
          ...(nestedConnectionId ? { connectionId: nestedConnectionId } : {}),
          mode
        })
        track(
          'add_repo_nested_import_result',
          buildNestedRepoImportResultTelemetry({
            attemptId,
            surface: 'sidebar',
            runtimeKind,
            mode,
            foundCount,
            selectedCount,
            result
          })
        )
        resultTracked = true
        if (!result) {
          return
        }
        const importedRepoIds = result.projects
          .map((entry) => entry.projectId)
          .filter((projectId): projectId is string => typeof projectId === 'string')
        const firstRepoId = importedRepoIds[0]
        if (!firstRepoId) {
          const firstFailure = result.projects.find((entry) => entry.status === 'failed')?.error
          toast.error('No repositories imported', {
            description: firstFailure ?? undefined
          })
          return
        }
        for (const projectId of importedRepoIds) {
          await fetchWorktrees(projectId)
        }
        const repo = useAppStore.getState().repos.find((entry) => entry.id === firstRepoId)
        if (repo) {
          setAddedRepo(repo)
          setExistingWorkspaceSource(
            nestedConnectionId
              ? 'ssh_remote_path'
              : settings?.activeRuntimeEnvironmentId?.trim()
                ? 'runtime_server_path'
                : 'local_folder_picker'
          )
          setStep('setup')
        }
        if (result.failedCount > 0) {
          toast.warning('Some repositories could not be imported', {
            description: `${result.failedCount} failed`
          })
        }
      } finally {
        if (!resultTracked) {
          track(
            'add_repo_nested_import_result',
            buildNestedRepoImportResultTelemetry({
              attemptId,
              surface: 'sidebar',
              runtimeKind,
              mode,
              foundCount,
              selectedCount,
              result: null
            })
          )
        }
        setIsAdding(false)
      }
    },
    [
      fetchWorktrees,
      importNestedRepos,
      nestedGroupName,
      nestedAttemptId,
      nestedScan,
      nestedSelectedPaths,
      nestedConnectionId,
      nestedRuntimeKind,
      getNestedRepoRuntimeKind,
      settings?.activeRuntimeEnvironmentId
    ]
  )

  const handleAddServerPath = useCallback(
    async (kind: 'git' | 'folder') => {
      const path = serverPath.trim()
      if (!path) {
        return
      }
      setIsAddingServerPath(true)
      try {
        if (kind === 'git') {
          const attemptId = createNestedRepoTelemetryAttemptId()
          const scan = await scanNestedRepos(path)
          track(
            'add_repo_nested_scan_result',
            buildNestedRepoScanTelemetry({
              attemptId,
              surface: 'sidebar',
              runtimeKind: getNestedRepoRuntimeKind(null),
              scan
            })
          )
          if (scan?.selectedPathKind === 'non_git_folder' && scan.repos.length > 0) {
            setNestedScan(scan)
            setNestedSelectedPaths(new Set(scan.repos.map((repo) => repo.path)))
            setNestedGroupName(defaultProjectGroupNameForPath(path))
            setNestedConnectionId(null)
            setNestedAttemptId(attemptId)
            setNestedRuntimeKind(getNestedRepoRuntimeKind(null))
            setStep('nested')
            return
          }
        }
        const repo = await addRepoPath(path, kind)
        if (repo && isGitRepoKind(repo)) {
          setAddedRepo(repo)
          setExistingWorkspaceSource('runtime_server_path')
          await fetchWorktrees(repo.id)
          setStep('setup')
        } else if (repo) {
          // Why: folder repos skip the Git worktree setup step; their synthetic
          // root workspace is opened by the folder add flow.
          closeModal()
        }
      } finally {
        setIsAddingServerPath(false)
      }
    },
    [addRepoPath, closeModal, fetchWorktrees, getNestedRepoRuntimeKind, scanNestedRepos, serverPath]
  )

  const handlePickDestination = useCallback(async () => {
    if (settings?.activeRuntimeEnvironmentId?.trim()) {
      // Why: the native folder picker returns a client-local path. Runtime
      // clone destinations must be typed as server paths.
      toast.error('Enter a server path for the clone destination.')
      return
    }
    const dir = await window.api.repos.pickDirectory()
    if (dir) {
      setCloneDestination(dir)
      setCloneError(null)
    }
  }, [settings?.activeRuntimeEnvironmentId])

  const handleClone = useCallback(async () => {
    const trimmedUrl = cloneUrl.trim()
    if (!trimmedUrl || !cloneDestination.trim()) {
      return
    }
    const gen = ++cloneGenRef.current
    setIsCloning(true)
    setCloneError(null)
    setCloneProgress(null)
    try {
      const target = getActiveRuntimeTarget(useAppStore.getState().settings)
      const repo =
        target.kind === 'environment'
          ? (
              await callRuntimeRpc<{ repo: Repo }>(
                target,
                'repo.clone',
                {
                  url: trimmedUrl,
                  destination: cloneDestination.trim()
                },
                { timeoutMs: 10 * 60_000 }
              )
            ).repo
          : ((await window.api.repos.clone({
              url: trimmedUrl,
              destination: cloneDestination.trim()
            })) as Repo)
      // Why: if the user closed the dialog or clicked Back during the clone,
      // cloneGenRef will have been bumped by resetState. Ignore this stale result.
      if (gen !== cloneGenRef.current) {
        return
      }
      toast.success('Repository cloned', { description: repo.displayName })
      // Why: eagerly upsert so step 2 finds the repo before the IPC event.
      const state = useAppStore.getState()
      const existingIdx = state.repos.findIndex((r) => r.id === repo.id)
      if (existingIdx === -1) {
        useAppStore.setState({ repos: [...state.repos, repo] })
      } else {
        const updated = [...state.repos]
        updated[existingIdx] = repo
        useAppStore.setState({ repos: updated })
      }
      setAddedRepo(repo)
      setExistingWorkspaceSource('clone_url')
      await fetchWorktrees(repo.id)
      setStep('setup')
    } catch (err) {
      if (gen !== cloneGenRef.current) {
        return
      }
      const message = err instanceof Error ? err.message : String(err)
      setCloneError(message)
    } finally {
      if (gen === cloneGenRef.current) {
        setIsCloning(false)
      }
    }
  }, [cloneUrl, cloneDestination, fetchWorktrees])

  const existingWorkspaceTelemetry = useMemo(
    () => buildAddRepoExistingWorkspacesTelemetry(existingWorkspaceSource, sortedWorktrees),
    [existingWorkspaceSource, sortedWorktrees]
  )

  const detectedTelemetryTrackedRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (
      step !== 'setup' ||
      !projectId ||
      !existingWorkspaceTelemetry ||
      !shouldTrackAddRepoExistingWorkspacesDetected(existingWorkspaceTelemetry) ||
      detectedTelemetryTrackedRef.current.has(projectId)
    ) {
      return
    }
    detectedTelemetryTrackedRef.current.add(projectId)
    track('add_repo_existing_workspaces_detected', existingWorkspaceTelemetry)
  }, [existingWorkspaceSource, existingWorkspaceTelemetry, projectId, step])

  const trackSetupAction = useCallback(
    (action: AddRepoSetupStepAction): void => {
      track('add_repo_setup_step_action', {
        action,
        ...(existingWorkspaceTelemetry
          ? {
              source: existingWorkspaceTelemetry.source,
              existing_workspace_count: existingWorkspaceTelemetry.existing_workspace_count,
              existing_linked_workspace_count:
                existingWorkspaceTelemetry.existing_linked_workspace_count
            }
          : {})
      })
    },
    [existingWorkspaceTelemetry]
  )

  const handleCreateWorktree = useCallback(
    (name?: string) => {
      // Why: Setup-step "Create" affordance — fires on click intent, not on IPC arrival, mirroring the other 4 actions in this dialog.
      trackSetupAction('create_worktree')
      // Why: small delay so the Add Project dialog close animation finishes before
      // the composer modal takes focus; otherwise the dialog teardown can steal
      // the first focus frame from the composer's prompt textarea.
      closeModal()
      setTimeout(() => {
        openModal('new-workspace-composer', {
          initialRepoId: projectId,
          ...(name ? { prefilledName: name } : {}),
          telemetrySource: 'sidebar'
        })
      }, 150)
    },
    [closeModal, openModal, projectId, trackSetupAction]
  )

  const handleStartPrimaryWorktree = useCallback(() => {
    if (!primaryWorktree) {
      return
    }
    trackSetupAction('open_primary')
    closeModal()
    if (useAppStore.getState().hideDefaultBranchWorkspace) {
      setHideDefaultBranchWorkspace(false)
    }
    activateAndRevealWorktree(primaryWorktree.id)
  }, [closeModal, primaryWorktree, setHideDefaultBranchWorkspace, trackSetupAction])

  const handleConfigureRepo = useCallback(() => {
    trackSetupAction('configure')
    closeModal()
    openSettingsTarget({ pane: 'repo', repoId: projectId })
    openSettingsPage()
  }, [closeModal, openSettingsTarget, openSettingsPage, projectId, trackSetupAction])

  const finishImportedRepoWithoutOpening = useCallback(async () => {
    const importedRepoId = projectId
    closeModal()
    resetState()
    if (!importedRepoId) {
      return
    }

    await fetchWorktrees(importedRepoId)
    const state = useAppStore.getState()
    finalizeImportedRepoAfterSkip(state, importedRepoId)
  }, [closeModal, fetchWorktrees, projectId, resetState])

  const handleUseExistingWorktrees = useCallback(async () => {
    if (!projectId) {
      return
    }
    trackSetupAction('open_existing')
    if (!otherWorktreesVisible) {
      const updated = await updateRepo(projectId, { externalWorktreeVisibility: 'show' })
      if (updated && addedRepo) {
        setAddedRepo({ ...addedRepo, externalWorktreeVisibility: 'show' })
      }
      await fetchWorktrees(projectId)
    }
    await finishImportedRepoWithoutOpening()
  }, [
    addedRepo,
    fetchWorktrees,
    finishImportedRepoWithoutOpening,
    otherWorktreesVisible,
    projectId,
    trackSetupAction,
    updateRepo
  ])

  const trackNestedBackAction = useCallback((): void => {
    if (nestedScan && nestedAttemptId) {
      track(
        'add_repo_nested_import_action',
        buildNestedRepoImportActionTelemetry({
          attemptId: nestedAttemptId,
          surface: 'sidebar',
          runtimeKind: nestedRuntimeKind ?? getNestedRepoRuntimeKind(nestedConnectionId),
          action: 'back',
          foundCount: nestedScan.repos.length,
          selectedCount: nestedSelectedPaths.size
        })
      )
    }
  }, [
    getNestedRepoRuntimeKind,
    nestedAttemptId,
    nestedConnectionId,
    nestedRuntimeKind,
    nestedScan,
    nestedSelectedPaths.size
  ])

  // Why: handleBack reuses resetState which already aborts clones and resets all fields.
  const handleBack = useCallback(() => {
    if (step === 'nested') {
      trackNestedBackAction()
    }
    resetState()
  }, [resetState, step, trackNestedBackAction])

  // Why: only the Setup step's "Add another project" back arrow counts as a
  // funnel event — the in-flight Back arrows on clone/remote/create are not
  // a Setup-step affordance. Keeping the emit scoped to this handler avoids
  // also tagging mid-clone backs.
  const handleSetupStepBack = useCallback(() => {
    trackSetupAction('back')
    handleBack()
  }, [handleBack, trackSetupAction])

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => {
        if (!open) {
          // Why: Radix only fires onOpenChange for internal triggers (X icon, ESC,
          // outside-click), so this branch only runs for implicit closes — explicit
          // Skip is handled on its own renderer-side click handler. Implicit closes
          // on the Setup step are funnel-equivalent to Skip.
          if (step === 'setup') {
            trackSetupAction('skip')
            void finishImportedRepoWithoutOpening()
            return
          }
          if (step === 'nested' && !isAdding) {
            trackNestedBackAction()
          }
          closeModal()
          resetState()
        }
      }}
    >
      <DialogContent
        className={`min-w-0 overflow-hidden sm:max-w-lg [&>*]:min-w-0 ${
          step === 'nested' ? 'max-h-[calc(100vh-2rem)] grid-rows-[auto_auto_minmax(0,1fr)]' : ''
        }`}
      >
        {/* Step indicator row — back button (step 2 only), dots, X is rendered by DialogContent */}
        <div className="flex items-center justify-center -mt-1">
          {(step === 'clone' || step === 'remote' || step === 'create') && (
            <button
              className="absolute left-6 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
              onClick={handleBack}
            >
              <ArrowLeft className="size-3" />
              Back
            </button>
          )}
          {step === 'nested' && (
            <button
              className="absolute left-6 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer disabled:cursor-default disabled:opacity-40"
              disabled={isAdding}
              onClick={handleBack}
            >
              <ArrowLeft className="size-3" />
              Back
            </button>
          )}
          {step === 'setup' && (
            <button
              className="absolute left-6 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
              onClick={handleSetupStepBack}
            >
              <ArrowLeft className="size-3" />
              Add another project
            </button>
          )}
          <div className="flex items-center gap-1.5">
            <div
              className={`size-1.5 rounded-full transition-colors ${isInputStep ? 'bg-foreground' : 'bg-muted-foreground/30'}`}
            />
            <div
              className={`size-1.5 rounded-full transition-colors ${step === 'setup' ? 'bg-foreground' : 'bg-muted-foreground/30'}`}
            />
          </div>
        </div>

        {step === 'add' && isRuntimeEnvironmentActive ? (
          <>
            <DialogHeader>
              <DialogTitle>Add a server project</DialogTitle>
              <DialogDescription>
                Add a Git repository or folder that already exists on the selected runtime server.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-3 pt-2">
              <div className="space-y-1">
                <label
                  htmlFor="server-project-path"
                  className="text-[11px] font-medium text-muted-foreground block"
                >
                  Server path
                </label>
                <Input
                  id="server-project-path"
                  value={serverPath}
                  onChange={(event) => setServerPath(event.target.value)}
                  placeholder="/home/user/project"
                  className="h-11 text-sm font-mono"
                  disabled={isAddingServerPath}
                  autoFocus
                  spellCheck={false}
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Button
                  onClick={() => void handleAddServerPath('git')}
                  disabled={!serverPath.trim() || isAddingServerPath}
                  className="h-10"
                >
                  Add Git Project
                </Button>
                <Button
                  onClick={() => void handleAddServerPath('folder')}
                  disabled={!serverPath.trim() || isAddingServerPath}
                  variant="outline"
                  className="h-10"
                >
                  Open as Folder
                </Button>
              </div>
              <div className="flex items-center justify-center gap-4 pt-1">
                <button
                  type="button"
                  onClick={() => {
                    setCloneError(null)
                    setStep('clone')
                  }}
                  className="text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer rounded focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                >
                  Clone into server path
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setCreateError(null)
                    setStep('create')
                  }}
                  className="text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer rounded focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                >
                  Create on server
                </button>
              </div>
            </div>
          </>
        ) : step === 'add' ? (
          <>
            <DialogHeader>
              <DialogTitle>Add a project</DialogTitle>
              <DialogDescription>
                {repos.length === 0
                  ? 'Add a project to get started with Orca.'
                  : 'Add another project to manage with Orca.'}
              </DialogDescription>
            </DialogHeader>

            <div className="grid grid-cols-3 gap-3 pt-2">
              <Button
                onClick={handleBrowse}
                disabled={isAdding}
                variant="outline"
                className="h-auto py-5 px-2 flex flex-col items-center gap-2 text-center border-border/80"
              >
                <FolderOpen className="size-6 text-muted-foreground" />
                <div>
                  <p className="text-sm font-medium">Browse folder</p>
                  <p className="text-[11px] text-muted-foreground font-normal mt-0.5">
                    Local Git project or folder
                  </p>
                </div>
              </Button>

              <Button
                onClick={() => setStep('clone')}
                variant="outline"
                className="h-auto py-5 px-2 flex flex-col items-center gap-2 text-center border-border/80"
              >
                <Globe className="size-6 text-muted-foreground" />
                <div>
                  <p className="text-sm font-medium">Clone from URL</p>
                  <p className="text-[11px] text-muted-foreground font-normal mt-0.5">
                    Remote Git repository
                  </p>
                </div>
              </Button>

              <Button
                onClick={handleOpenRemoteStep}
                variant="outline"
                className="h-auto py-5 px-2 flex flex-col items-center gap-2 text-center border-border/80"
              >
                <Monitor className="size-6 text-muted-foreground" />
                <div>
                  <p className="text-sm font-medium">Remote project</p>
                  <p className="text-[11px] text-muted-foreground font-normal mt-0.5">
                    SSH connected target
                  </p>
                </div>
              </Button>
            </div>

            <div className="flex items-center gap-2 rounded-md border border-border bg-muted px-3 py-2 text-xs text-muted-foreground">
              <span className="grid size-6 shrink-0 place-items-center rounded-md border border-border bg-background text-foreground">
                <Lightbulb className="size-3.5" />
              </span>
              <span>Want to import many repos at once? Select the parent folder.</span>
            </div>

            {/* Secondary link rather than a fourth card — create-from-scratch
               is a less common path than importing. See orca#763. */}
            <div className="flex items-center justify-center pt-1">
              <button
                type="button"
                onClick={() => {
                  setCreateError(null)
                  setStep('create')
                }}
                className="text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer rounded focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                Or start a new project from scratch
              </button>
            </div>
          </>
        ) : step === 'remote' ? (
          <RemoteStep
            sshTargets={sshTargets}
            selectedTargetId={selectedTargetId}
            remotePath={remotePath}
            remoteError={remoteError}
            isAddingRemote={isAddingRemote}
            onSelectTarget={(id) => {
              setSelectedTargetId(id)
              setRemoteError(null)
            }}
            onRemotePathChange={(value) => {
              setRemotePath(value)
              setRemoteError(null)
            }}
            onAdd={handleAddRemoteRepo}
            onOpenSshSettings={() => {
              closeModal()
              openSettingsTarget({ pane: 'ssh', repoId: null, sectionId: 'ssh' })
              openSettingsPage()
            }}
            onConnectTarget={handleConnectTarget}
          />
        ) : step === 'clone' ? (
          <CloneStep
            cloneUrl={cloneUrl}
            cloneDestination={cloneDestination}
            cloneError={cloneError}
            cloneProgress={cloneProgress}
            isCloning={isCloning}
            disableDestinationPicker={isRuntimeEnvironmentActive}
            onUrlChange={(value) => {
              setCloneUrl(value)
              setCloneError(null)
            }}
            onDestChange={(value) => {
              setCloneDestination(value)
              setCloneError(null)
            }}
            onPickDestination={handlePickDestination}
            onClone={handleClone}
          />
        ) : step === 'nested' && nestedScan ? (
          <>
            <DialogHeader>
              <DialogTitle>Import as project group</DialogTitle>
              <DialogDescription>
                {`Found ${nestedScan.repos.length} git ${
                  nestedScan.repos.length === 1 ? 'repository' : 'repositories'
                } in this folder.`}
              </DialogDescription>
            </DialogHeader>

            <div className="flex min-h-0 min-w-0 max-w-full flex-col gap-3 overflow-hidden pt-1">
              <div className="flex min-w-0 max-w-full items-center gap-3 overflow-hidden rounded-md border border-border bg-muted/30 p-3">
                <div className="grid size-9 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
                  <FolderTree className="size-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-foreground">
                    Group under {nestedGroupName}
                  </div>
                  <div className="truncate text-[11px] text-muted-foreground">
                    {nestedScan.selectedPath}
                  </div>
                </div>
              </div>

              <div className="min-w-0 space-y-1">
                <label className="text-[11px] font-medium text-muted-foreground">Group name</label>
                <Input
                  value={nestedGroupName}
                  onChange={(event) => setNestedGroupName(event.target.value)}
                  className="h-9"
                />
              </div>

              <NestedRepoTreePreview
                scan={nestedScan}
                selectedPaths={nestedSelectedPaths}
                onSelectedPathsChange={setNestedSelectedPaths}
                disabled={isAdding}
                className="flex-1"
              />
              {nestedScan.truncated || nestedScan.timedOut ? (
                <div className="text-[11px] text-muted-foreground">
                  Showing partial results from a bounded scan.
                </div>
              ) : null}
              <div className="shrink-0 flex items-center gap-2">
                <Button onClick={handleBack} disabled={isAdding} variant="ghost">
                  <ArrowLeft className="size-3.5" />
                  Back
                </Button>
                <div className="ml-auto flex items-center gap-2">
                  <Button
                    onClick={() => void handleImportNestedRepos('separate')}
                    disabled={isAdding || nestedSelectedPaths.size === 0}
                    variant="outline"
                  >
                    Import separately
                  </Button>
                  <Button
                    onClick={() => void handleImportNestedRepos('group')}
                    disabled={isAdding || nestedSelectedPaths.size === 0 || !nestedGroupName.trim()}
                  >
                    Import as project group
                  </Button>
                </div>
              </div>
            </div>
          </>
        ) : step === 'create' ? (
          <CreateStep
            createName={createName}
            createParent={createParent}
            createKind={createKind}
            createError={createError}
            isCreating={isCreating}
            manualParentEntry={isRuntimeEnvironmentActive}
            onNameChange={(value) => {
              setCreateName(value)
              setCreateError(null)
            }}
            onParentChange={(value) => {
              setCreateParent(value)
              setCreateError(null)
            }}
            onKindChange={(kind) => {
              setCreateKind(kind)
              setCreateError(null)
            }}
            onPickParent={handlePickParent}
            onCreate={handleCreate}
          />
        ) : (
          <SetupStep
            repoName={addedRepo?.displayName ?? ''}
            hiddenWorktreeCount={hiddenWorktreeCount}
            primaryBranchName={primaryBranchName}
            onStartPrimaryWorktree={handleStartPrimaryWorktree}
            onUseExistingWorktrees={() => void handleUseExistingWorktrees()}
            onCreateWorktree={handleCreateWorktree}
            onConfigureRepo={handleConfigureRepo}
          />
        )}
      </DialogContent>
    </Dialog>
  )
})

export default AddRepoDialog
