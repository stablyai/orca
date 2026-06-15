import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useShallow } from 'zustand/react/shallow'
import AgentSettingsDialog from '@/components/agent/AgentSettingsDialog'
import NewWorkspaceComposerCard from '@/components/NewWorkspaceComposerCard'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { useDetectedAgents } from '@/hooks/useDetectedAgents'
import { useAppStore } from '@/store'
import { getLinkedWorkItemProvider, type LinkedWorkItemSummary } from '@/lib/new-workspace'
import {
  pickQuickWorkspaceAgent,
  resolveQuickWorkspaceAgentSelection
} from '@/lib/quick-workspace-agent-selection'
import { getSelectedRepoSshGate, isSshConnectInProgress } from '@/lib/new-workspace-ssh-gate'
import { isWorkItemLookupText } from '@/lib/work-item-lookup-text'
import { buildNewWorkspaceProjectOptions } from '@/lib/new-workspace-project-options'
import type {
  GitHubWorkItem,
  GitLabWorkItem,
  LinearIssue,
  ProjectGroup,
  TuiAgent
} from '../../../../shared/types'
import type { SshConnectionStatus } from '../../../../shared/ssh-types'
import { translate } from '@/i18n/i18n'
import {
  getFolderSourceRepos,
  getFolderWorkspacePrimaryActionLabel,
  getLinkedItemDisplayName,
  getSmartNameSelection,
  toGitHubLinkedWorkItem,
  toGitLabLinkedWorkItem,
  toLinearLinkedWorkItem
} from './folder-workspace-composer-helpers'
import { useFolderWorkspaceComposerPathStatus } from './folder-workspace-composer-path-status'
import { submitFolderWorkspaceCreate } from './folder-workspace-composer-submit'
import { projectHostSetupProjectionFromRepos } from '../../../../shared/project-host-setup-projection'
import { useFolderWorkspaceComposerKeyboard } from './folder-workspace-composer-keyboard'

type FolderWorkspaceComposerDialogProps = {
  projectGroup: ProjectGroup | null
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function FolderWorkspaceComposerDialog({
  projectGroup,
  open,
  onOpenChange
}: FolderWorkspaceComposerDialogProps): React.JSX.Element {
  const { createFolderWorkspace, projectGroups, repos, settings, sshConnectionStates } =
    useAppStore(
      useShallow((s) => ({
        createFolderWorkspace: s.createFolderWorkspace,
        projectGroups: s.projectGroups,
        repos: s.repos,
        settings: s.settings,
        sshConnectionStates: s.sshConnectionStates
      }))
    )
  const { pathStatusBlocksCreate, pathStatusProjectError } = useFolderWorkspaceComposerPathStatus(
    projectGroup,
    open
  )
  const sourceRepos = useMemo(
    () => getFolderSourceRepos(repos, projectGroups, projectGroup),
    [projectGroup, projectGroups, repos]
  )
  const [repoId, setRepoId] = useState('')
  const projectSetupProjection = useMemo(
    () => projectHostSetupProjectionFromRepos(sourceRepos),
    [sourceRepos]
  )
  const projectOptions = useMemo(
    () =>
      buildNewWorkspaceProjectOptions({
        projects: projectSetupProjection.projects,
        projectHostSetups: projectSetupProjection.setups,
        eligibleRepos: sourceRepos
      }),
    [projectSetupProjection, sourceRepos]
  )
  const selectedRepo = sourceRepos.find((repo) => repo.id === repoId) ?? null
  const selectedProjectHostSetup = projectSetupProjection.setups.find(
    (setup) => setup.repoId === repoId
  )
  const selectedProjectId = selectedProjectHostSetup?.projectId ?? null
  const selectedRepoConnectionId =
    selectedRepo?.connectionId ??
    (sourceRepos.length === 0 ? (projectGroup?.connectionId ?? null) : null)
  const selectedRepoSshState = selectedRepoConnectionId
    ? (sshConnectionStates.get(selectedRepoConnectionId) ?? null)
    : null
  const { selectedRepoSshStatus, selectedRepoRequiresConnection, selectedRepoConnectInProgress } =
    getSelectedRepoSshGate({
      connectionId: selectedRepoConnectionId,
      status: selectedRepoSshState?.status ?? null
    })
  const { detectedIds } = useDetectedAgents(selectedRepoConnectionId)
  const detectedAgentIds = useMemo(() => (detectedIds ? new Set(detectedIds) : null), [detectedIds])
  const [name, setName] = useState('')
  const [note, setNote] = useState('')
  const [linkedWorkItem, setLinkedWorkItem] = useState<LinkedWorkItemSummary | null>(null)
  const [quickAgentOverride, setQuickAgentOverride] = useState<TuiAgent | null | undefined>(
    undefined
  )
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [agentSettingsOpen, setAgentSettingsOpen] = useState(false)
  const lastAutoNameRef = useRef('')
  const composerRef = useRef<HTMLDivElement | null>(null)
  const nameInputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (!open) {
      return
    }
    setRepoId(sourceRepos[0]?.id ?? '')
    setName('')
    setNote('')
    setLinkedWorkItem(null)
    setQuickAgentOverride(undefined)
    setAdvancedOpen(false)
    setSubmitting(false)
    lastAutoNameRef.current = ''
  }, [open, projectGroup?.id, sourceRepos])

  const preferredQuickAgent = useMemo<TuiAgent | null>(
    () =>
      pickQuickWorkspaceAgent(
        settings?.defaultTuiAgent,
        detectedAgentIds,
        settings?.disabledTuiAgents
      ),
    [detectedAgentIds, settings?.defaultTuiAgent, settings?.disabledTuiAgents]
  )
  const resolvedQuickAgentSelection = resolveQuickWorkspaceAgentSelection({
    quickAgentOverride,
    preferredQuickAgent,
    detectedAgentIds,
    disabledTuiAgents: settings?.disabledTuiAgents
  })
  if (resolvedQuickAgentSelection.quickAgentOverride !== quickAgentOverride) {
    setQuickAgentOverride(resolvedQuickAgentSelection.quickAgentOverride)
  }
  const quickAgent = resolvedQuickAgentSelection.quickAgent

  const applyLinkedWorkItem = useCallback(
    (item: LinkedWorkItemSummary): void => {
      setLinkedWorkItem(item)
      const nextName = getLinkedItemDisplayName(item)
      if (
        nextName &&
        (!name.trim() || name === lastAutoNameRef.current || isWorkItemLookupText(name))
      ) {
        setName(nextName)
        lastAutoNameRef.current = nextName
      }
    },
    [name]
  )

  const handleRepoChange = useCallback((nextRepoId: string): void => {
    setRepoId(nextRepoId)
    setLinkedWorkItem((current) => {
      const provider = current ? getLinkedWorkItemProvider(current) : null
      return provider === 'github' || provider === 'gitlab' ? null : current
    })
  }, [])
  const handleProjectChange = useCallback(
    (projectId: string): void => {
      const setup = projectSetupProjection.setups.find(
        (candidate) => candidate.projectId === projectId
      )
      if (setup) {
        handleRepoChange(setup.repoId)
      }
    },
    [handleRepoChange, projectSetupProjection]
  )

  const handleSmartGitHubItemSelect = useCallback(
    (item: GitHubWorkItem): void => {
      applyLinkedWorkItem(toGitHubLinkedWorkItem(item))
    },
    [applyLinkedWorkItem]
  )

  const handleSmartGitLabItemSelect = useCallback(
    (item: GitLabWorkItem): void => {
      applyLinkedWorkItem(toGitLabLinkedWorkItem(item))
    },
    [applyLinkedWorkItem]
  )

  const handleSmartLinearIssueSelect = useCallback(
    (issue: LinearIssue): void => {
      applyLinkedWorkItem(toLinearLinkedWorkItem(issue))
    },
    [applyLinkedWorkItem]
  )

  const handleClearSmartNameSelection = useCallback((): void => {
    setLinkedWorkItem(null)
    if (name === lastAutoNameRef.current) {
      setName('')
      lastAutoNameRef.current = ''
    }
  }, [name])

  const handleQuickAgentChange = useCallback((agent: TuiAgent | null): void => {
    setQuickAgentOverride(agent)
  }, [])

  const onConnectSelectedRepo = useCallback(async (): Promise<void> => {
    if (!selectedRepoConnectionId) {
      return
    }
    const liveStatus = useAppStore
      .getState()
      .sshConnectionStates.get(selectedRepoConnectionId)?.status
    if (liveStatus === 'connected' || isSshConnectInProgress(liveStatus ?? null)) {
      return
    }
    try {
      await window.api.ssh.connect({ targetId: selectedRepoConnectionId })
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : translate(
              'auto.components.sidebar.FolderWorkspaceComposerDialog.connectFailed',
              'Failed to connect to project.'
            )
      )
    }
  }, [selectedRepoConnectionId])

  const handleCreate = useCallback(async (): Promise<void> => {
    if (
      !projectGroup?.parentPath ||
      submitting ||
      pathStatusBlocksCreate ||
      selectedRepoRequiresConnection
    ) {
      return
    }
    setSubmitting(true)
    try {
      await submitFolderWorkspaceCreate({
        projectGroup,
        name,
        lastAutoName: lastAutoNameRef.current,
        linkedWorkItem,
        note,
        quickAgent,
        autoRenameBranchFromWork: settings?.autoRenameBranchFromWork,
        agentCmdOverrides: settings?.agentCmdOverrides,
        createFolderWorkspace,
        onOpenChange
      })
    } finally {
      setSubmitting(false)
    }
  }, [
    createFolderWorkspace,
    linkedWorkItem,
    name,
    note,
    onOpenChange,
    projectGroup,
    quickAgent,
    settings?.agentCmdOverrides,
    settings?.autoRenameBranchFromWork,
    submitting,
    pathStatusBlocksCreate,
    selectedRepoRequiresConnection
  ])

  useFolderWorkspaceComposerKeyboard({
    open,
    submitting,
    composerRef,
    onOpenChange,
    onCreate: () => void handleCreate()
  })

  const smartNameSelection = useMemo(() => getSmartNameSelection(linkedWorkItem), [linkedWorkItem])
  const emptySourceProjectMessage =
    sourceRepos.length === 0
      ? translate(
          'auto.components.sidebar.FolderWorkspaceComposerDialog.noRepos',
          'Add a Git project under this folder to attach GitHub or GitLab tasks.'
        )
      : null

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          className="flex max-h-[calc(100vh-2rem)] flex-col overflow-hidden sm:max-w-lg"
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            const content = event.currentTarget as HTMLElement
            const trigger = content.querySelector<HTMLElement>(
              '[data-project-combobox-root="true"][role="combobox"]'
            )
            trigger?.focus({ preventScroll: true })
          }}
        >
          <DialogHeader className="gap-1">
            <DialogTitle className="text-base font-semibold">
              {translate(
                'auto.components.sidebar.FolderWorkspaceComposerDialog.title',
                'Create Folder Workspace'
              )}
            </DialogTitle>
            <DialogDescription>{projectGroup?.parentPath ?? ''}</DialogDescription>
          </DialogHeader>
          <NewWorkspaceComposerCard
            containerClassName="min-h-0 flex-1 overflow-y-auto px-1 scrollbar-sleek"
            composerRef={composerRef}
            nameInputRef={nameInputRef}
            quickAgent={quickAgent}
            onQuickAgentChange={handleQuickAgentChange}
            eligibleRepos={sourceRepos}
            repoId={repoId}
            projectOptions={projectOptions}
            selectedProjectId={selectedProjectId}
            selectedRepoIsGit={true}
            onRepoChange={handleRepoChange}
            onProjectChange={handleProjectChange}
            primaryActionLabel={getFolderWorkspacePrimaryActionLabel(quickAgent)}
            projectLabel={translate(
              'auto.components.sidebar.FolderWorkspaceComposerDialog.sourceProject',
              'Task Source'
            )}
            projectPlaceholder={translate(
              'auto.components.sidebar.FolderWorkspaceComposerDialog.chooseSourceProject',
              'Choose task source'
            )}
            emptyProjectMessage={emptySourceProjectMessage ?? undefined}
            showAddProjectButton={false}
            name={name}
            onNameValueChange={setName}
            onSmartGitHubItemSelect={handleSmartGitHubItemSelect}
            onSmartGitLabItemSelect={handleSmartGitLabItemSelect}
            onSmartBranchSelect={() => {}}
            onSmartLinearIssueSelect={handleSmartLinearIssueSelect}
            smartNameSelection={smartNameSelection}
            onClearSmartNameSelection={handleClearSmartNameSelection}
            forkPushWarning={null}
            detectedAgentIds={detectedAgentIds}
            onOpenAgentSettings={() => setAgentSettingsOpen(true)}
            advancedOpen={advancedOpen}
            onToggleAdvanced={() => setAdvancedOpen((value) => !value)}
            createDisabled={
              submitting ||
              !projectGroup?.parentPath ||
              pathStatusBlocksCreate ||
              selectedRepoRequiresConnection
            }
            projectError={pathStatusProjectError}
            creating={submitting}
            onCreate={() => void handleCreate()}
            note={note}
            onNoteChange={setNote}
            setupConfig={null}
            requiresExplicitSetupChoice={false}
            setupDecision={null}
            onSetupDecisionChange={() => {}}
            shouldWaitForSetupCheck={false}
            resolvedSetupDecision={null}
            createError={null}
            selectedRepoConnectionId={selectedRepoConnectionId}
            selectedRepoSshStatus={selectedRepoSshStatus as SshConnectionStatus | null}
            selectedRepoRequiresConnection={selectedRepoRequiresConnection}
            selectedRepoConnectInProgress={selectedRepoConnectInProgress}
            onConnectSelectedRepo={onConnectSelectedRepo}
            branchesEnabled={false}
            setupControlsEnabled={false}
            canUseSparseCheckout={false}
            sparsePresets={[]}
            sparseSelectedPresetId={null}
            onSparseSelectPreset={() => {}}
            sparseControlsEnabled={false}
          />
        </DialogContent>
      </Dialog>
      <AgentSettingsDialog open={agentSettingsOpen} onOpenChange={setAgentSettingsOpen} />
    </>
  )
}
