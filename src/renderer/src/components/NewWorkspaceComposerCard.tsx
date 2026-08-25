/* eslint-disable max-lines -- Why: keep the full composer card markup together so the inline and modal variants share one UI surface. */
import React from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import {
  AlertTriangle,
  Check,
  ChevronDown,
  CornerDownLeft,
  FolderPlus,
  LoaderCircle,
  PlugZap,
  Settings2
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { SwitchIndicator } from '@/components/ui/switch'
import { SettingsSwitch } from '@/components/settings/SettingsFormControls'
import type RepoCombobox from '@/components/repo/RepoCombobox'
import AgentCombobox from '@/components/agent/AgentCombobox'
import { getAgentCatalog } from '@/lib/agent-catalog'
import {
  DEFAULT_DISABLED_TUI_AGENTS,
  filterEnabledTuiAgents
} from '../../../shared/tui-agent-selection'
import { useAppStore } from '@/store'
import { cn } from '@/lib/utils'
import { WORKSPACE_FILE_PATH_MIME } from '@/lib/workspace-file-drag'
import {
  TEXT_CONTROL_PASTE_DIRECT_MAX_BYTES,
  measureTextControlPasteByteLength,
  pasteTextIntoTextControl,
  shouldHandleTextControlPaste
} from '@/lib/text-control-paste'
import { getScreenSubmitModifierLabel } from '@/lib/screen-submit-shortcut'
import { useContextualTour } from '@/components/contextual-tours/use-contextual-tour'
import { resolveProjectCloneUrlPrefill } from '@/lib/project-clone-url-prefill'
import type { GitHubWorkItem } from '../../../shared/github/work-item-types'
import type { GitLabWorkItem } from '../../../shared/gitlab-types'
import type { JiraIssue } from '../../../shared/jira-types'
import type { LinearIssue } from '../../../shared/linear/issue-types'
import type { OrcaHooks, SetupAgentStartupPolicy } from '../../../shared/orca-yaml-hook-types'
import type { TuiAgent } from '../../../shared/tui-agent'
import type { SparsePreset } from '../../../shared/worktree/create-types'
import SparseCheckoutPresetSelect from '@/components/sparse/SparseCheckoutPresetSelect'
import SmartWorkspaceNameField, {
  type SmartWorkspaceNameSelection
} from '@/components/new-workspace/SmartWorkspaceNameField'
import type { SmartNameMode } from '@/components/new-workspace/smart-workspace-source-results'
import ProjectCombobox from '@/components/new-workspace/ProjectCombobox'
import RunTargetCombobox from '@/components/new-workspace/RunTargetCombobox'
import { SetProjectLocationDialog } from '@/components/new-workspace/SetProjectLocationDialog'
import {
  AddRemoteHostDialog,
  type AddRemoteHostMode
} from '@/components/sidebar/AddRemoteHostDialog'
import type { SetupConfig } from '@/lib/new-workspace'
import type { NewWorkspaceProjectOption } from '@/lib/new-workspace-project-options'
import type {
  NeedsSetupProjectHostOption,
  ProjectHostSetupOption
} from '@/lib/project-host-setup-options'
import type { WorkspaceCreateErrorDisplay } from '@/lib/workspace-create-error-format'
import type { SshConnectionStatus } from '../../../shared/ssh-types'
import type { TaskSourceContext } from '../../../shared/task-source-context'
import type { RuntimeStatus } from '../../../shared/runtime-types'
import { unwrapRuntimeRpcResult } from '@/runtime/runtime-rpc-client'
import { translate } from '@/i18n/i18n'
import { withUiConnectTimeout } from '@/ssh/ssh-connect-ui-timeout'
import { isSshConnectInFlight, trackSshConnect } from '@/ssh/ssh-connect-in-flight'

type RepoOption = React.ComponentProps<typeof RepoCombobox>['repos'][number]
type EphemeralVmRecipeOption = NonNullable<OrcaHooks['environmentRecipes']>[number]
const EMPTY_PROJECT_OPTIONS: NewWorkspaceProjectOption[] = []
const EMPTY_PROJECT_HOST_SETUP_OPTIONS: ProjectHostSetupOption[] = []
const EMPTY_EPHEMERAL_VM_RECIPES: EphemeralVmRecipeOption[] = []

type NewWorkspaceComposerCardProps = {
  contextualTourSource?: string
  containerClassName?: string
  composerRef?: React.RefObject<HTMLDivElement | null>
  onComposerNodeChange?: (node: HTMLDivElement | null) => void
  nameInputRef?: React.RefObject<HTMLInputElement | null>
  quickAgent: TuiAgent | null
  onQuickAgentChange: (agent: TuiAgent | null) => void
  eligibleRepos: readonly RepoOption[]
  repoId: string
  projectOptions?: NewWorkspaceProjectOption[]
  selectedProjectId?: string | null
  selectedRepoIsGit: boolean
  onRepoChange: (value: string) => void
  onProjectChange: (value: string) => void
  projectHostSetupOptions?: ProjectHostSetupOption[]
  selectedProjectHostSetupId?: string | null
  onProjectHostSetupChange?: (setupId: string) => void
  ephemeralVmRecipes?: EphemeralVmRecipeOption[]
  selectedEphemeralVmRecipeId?: string | null
  onEphemeralVmRecipeChange?: (recipeId: string | null) => void
  ephemeralVmRecipeError?: string | null
  repoBackedSearchRepos?: readonly RepoOption[]
  repoBackedSourcesDisabled?: boolean
  allowSmartNameAddProject?: boolean
  smartNameRepoSwitchTarget?: 'project' | 'task-source'
  primaryActionLabel: string
  projectLabel?: string
  projectPlaceholder?: string
  emptyProjectMessage?: string
  showAddProjectButton?: boolean
  name: string
  onNameValueChange: (value: string) => void
  branchNameOverride: string | undefined
  onBranchNameOverrideChange: (value: string | undefined) => void
  onSmartGitHubItemSelect: (item: GitHubWorkItem) => void
  onSmartGitLabItemSelect: (item: GitLabWorkItem) => void
  onSmartBranchSelect: (refName: string, localBranchName: string) => void
  onSmartNameModeChange?: (mode: SmartNameMode) => void
  onSmartLinearIssueSelect: (issue: LinearIssue) => void
  onSmartJiraIssueSelect?: (issue: JiraIssue, sourceContext: TaskSourceContext) => void
  onOpenJiraSettings?: () => void
  smartNameSelection: SmartWorkspaceNameSelection | null
  onClearSmartNameSelection: () => void
  /** True when an existing local branch is selected and can be reused. */
  canReuseSelectedBranch: boolean
  reuseSelectedBranch: boolean
  onReuseSelectedBranchChange: (next: boolean) => void
  /** Shows the footer "Create more" switch — worktree targets only. */
  showCreateMultiple?: boolean
  createMultiple?: boolean
  onCreateMultipleChange?: (next: boolean) => void
  smartNameGitHubSourceContext?: TaskSourceContext | null
  smartNameJiraSourceContext?: TaskSourceContext | null
  /** Advisory shown under the name field when a fork PR can't accept maintainer pushes. */
  forkPushWarning: string | null
  detectedAgentIds: Set<TuiAgent> | null
  onOpenAgentSettings: () => void
  advancedOpen: boolean
  onToggleAdvanced: () => void
  createDisabled: boolean
  projectError: string | null
  creating: boolean
  onCreate: () => void
  note: string
  onNoteChange: (value: string) => void
  setupConfig: SetupConfig | null
  requiresExplicitSetupChoice: boolean
  setupDecision: 'run' | 'skip' | null
  onSetupDecisionChange: (value: 'run' | 'skip') => void
  setupAgentStartupPolicy: SetupAgentStartupPolicy
  onSetupAgentStartupPolicyChange: (value: SetupAgentStartupPolicy) => void
  shouldWaitForSetupCheck: boolean
  resolvedSetupDecision: 'run' | 'skip' | null
  createError: WorkspaceCreateErrorDisplay | null
  selectedRepoConnectionId: string | null
  selectedRepoSshStatus: SshConnectionStatus | null
  selectedRepoRequiresConnection: boolean
  selectedRepoConnectInProgress: boolean
  onConnectSelectedRepo: () => Promise<void>
  branchesEnabled?: boolean
  setupControlsEnabled?: boolean
  canUseSparseCheckout: boolean
  sparsePresets: SparsePreset[]
  sparseSelectedPresetId: string | null
  onSparseSelectPreset: (preset: SparsePreset | null) => void
  sparseControlsEnabled?: boolean
  /** When set, "Add project" opens a host-provided flow instead of swapping the store's active modal. */
  onAddProjectOverride?: () => void
  /** Fires as the nested Set-project-location dialog opens and closes, so the host can stand down its Escape/submit handling. */
  onNestedDialogOpenChange?: (open: boolean) => void
}

const SSH_STATUS_LABELS: Partial<Record<SshConnectionStatus, string>> = {
  get disconnected() {
    return translate(
      'auto.components.NewWorkspaceComposerCard.sshNotConnected',
      'SSH not connected'
    )
  },
  get connecting() {
    return translate('auto.components.NewWorkspaceComposerCard.connectingSsh', 'Connecting SSH...')
  },
  get 'auth-failed'() {
    return translate(
      'auto.components.NewWorkspaceComposerCard.sshAuthenticationFailed',
      'SSH authentication failed'
    )
  },
  get 'deploying-relay'() {
    return translate(
      'auto.components.NewWorkspaceComposerCard.preparingSshConnection',
      'Preparing SSH connection...'
    )
  },
  get connected() {
    return translate('auto.components.NewWorkspaceComposerCard.connected', 'Connected')
  },
  get reconnecting() {
    return translate(
      'auto.components.NewWorkspaceComposerCard.reconnectingSsh',
      'Reconnecting SSH...'
    )
  },
  get 'reconnection-failed'() {
    return translate(
      'auto.components.NewWorkspaceComposerCard.sshReconnectionFailed',
      'SSH reconnection failed'
    )
  },
  get error() {
    return translate('auto.components.NewWorkspaceComposerCard.a239038146', 'SSH connection error')
  }
}

function getSshStatusLabel(status: SshConnectionStatus): string {
  return SSH_STATUS_LABELS[status] ?? status
}

function SetupCommandPreview({ setupConfig }: { setupConfig: SetupConfig }): React.JSX.Element {
  // Why: just the script in a quiet monochrome card — the source label (orca.yaml / local) and
  // the run-setup toggle live in the section header above, so the card carries no chrome of its
  // own. Neutral foreground avoids the colored-terminal look. max-h keeps long scripts from
  // growing the dialog past the viewport.
  return (
    <div className="rounded-md border border-border/60 bg-muted/40 shadow-inner">
      <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words px-4 py-3 font-mono text-[12px] leading-5 text-foreground/90 scrollbar-sleek">
        {setupConfig.command}
      </pre>
    </div>
  )
}

function useComposerFileDragOver(): {
  isFileDragOver: boolean
  dragHandlers: {
    onDragEnter: (event: React.DragEvent<HTMLDivElement>) => void
    onDragLeave: (event: React.DragEvent<HTMLDivElement>) => void
  }
} {
  const [isFileDragOver, setIsFileDragOver] = React.useState(false)
  const dragCounterRef = React.useRef(0)

  const reset = React.useCallback(() => {
    dragCounterRef.current = 0
    setIsFileDragOver(false)
  }, [])

  const onDragEnter = React.useCallback((event: React.DragEvent<HTMLDivElement>): void => {
    // Why: "Files" is the DataTransfer type the OS adds for native drags; skip internal drags so they route to their own handlers.
    if (!event.dataTransfer.types.includes('Files')) {
      return
    }
    if (event.dataTransfer.types.includes(WORKSPACE_FILE_PATH_MIME)) {
      return
    }
    dragCounterRef.current += 1
    setIsFileDragOver(true)
  }, [])

  const onDragLeave = React.useCallback(
    (event: React.DragEvent<HTMLDivElement>): void => {
      if (!event.dataTransfer.types.includes('Files')) {
        return
      }
      // Why: mirror the onDragEnter guard so internal drags don't decrement a counter enter skipped incrementing (else it goes negative).
      if (event.dataTransfer.types.includes(WORKSPACE_FILE_PATH_MIME)) {
        return
      }
      dragCounterRef.current -= 1
      if (dragCounterRef.current <= 0) {
        reset()
      }
    },
    [reset]
  )

  // Why: preload stops native drop events before React's onDrop, so reset the drag highlight via a document capture listener.
  React.useEffect(() => {
    const handler = (): void => {
      reset()
    }
    document.addEventListener('drop', handler, true)
    document.addEventListener('dragend', handler, true)
    return () => {
      document.removeEventListener('drop', handler, true)
      document.removeEventListener('dragend', handler, true)
    }
  }, [reset])

  return {
    isFileDragOver,
    dragHandlers: { onDragEnter, onDragLeave }
  }
}

export default function NewWorkspaceComposerCard({
  contextualTourSource,
  containerClassName,
  composerRef,
  onComposerNodeChange,
  nameInputRef,
  quickAgent,
  onQuickAgentChange,
  eligibleRepos,
  repoId,
  projectOptions = EMPTY_PROJECT_OPTIONS,
  selectedProjectId = null,
  selectedRepoIsGit,
  onRepoChange,
  onProjectChange,
  projectHostSetupOptions = EMPTY_PROJECT_HOST_SETUP_OPTIONS,
  selectedProjectHostSetupId = null,
  onProjectHostSetupChange,
  ephemeralVmRecipes = EMPTY_EPHEMERAL_VM_RECIPES,
  selectedEphemeralVmRecipeId = null,
  onEphemeralVmRecipeChange,
  ephemeralVmRecipeError = null,
  repoBackedSearchRepos,
  repoBackedSourcesDisabled = false,
  allowSmartNameAddProject = true,
  smartNameRepoSwitchTarget = 'project',
  primaryActionLabel,
  projectLabel,
  projectPlaceholder,
  emptyProjectMessage,
  showAddProjectButton = true,
  name,
  onNameValueChange,
  branchNameOverride,
  onBranchNameOverrideChange,
  onSmartGitHubItemSelect,
  onSmartGitLabItemSelect,
  onSmartBranchSelect,
  onSmartNameModeChange,
  onSmartLinearIssueSelect,
  onSmartJiraIssueSelect,
  onOpenJiraSettings,
  smartNameSelection,
  onClearSmartNameSelection,
  canReuseSelectedBranch,
  reuseSelectedBranch,
  onReuseSelectedBranchChange,
  showCreateMultiple = false,
  createMultiple = false,
  onCreateMultipleChange,
  smartNameGitHubSourceContext,
  smartNameJiraSourceContext,
  forkPushWarning,
  detectedAgentIds,
  onOpenAgentSettings,
  advancedOpen,
  onToggleAdvanced,
  createDisabled,
  projectError,
  creating,
  onCreate,
  note,
  onNoteChange,
  setupConfig,
  requiresExplicitSetupChoice,
  setupDecision,
  onSetupDecisionChange,
  setupAgentStartupPolicy,
  onSetupAgentStartupPolicyChange,
  shouldWaitForSetupCheck,
  resolvedSetupDecision,
  createError,
  selectedRepoConnectionId,
  selectedRepoSshStatus,
  selectedRepoRequiresConnection,
  selectedRepoConnectInProgress,
  onConnectSelectedRepo,
  branchesEnabled = true,
  setupControlsEnabled = true,
  canUseSparseCheckout,
  sparsePresets,
  sparseSelectedPresetId,
  onSparseSelectPreset,
  sparseControlsEnabled = true,
  onAddProjectOverride,
  onNestedDialogOpenChange
}: NewWorkspaceComposerCardProps): React.JSX.Element {
  // Why: subscribe (form uses translate() directly) so an open create dialog repaints when the UI language changes.
  useTranslation()
  const { isFileDragOver, dragHandlers } = useComposerFileDragOver()
  const openModal = useAppStore((s) => s.openModal)
  const activeModal = useAppStore((s) => s.activeModal)
  const defaultTuiAgent = useAppStore((s) => s.settings?.defaultTuiAgent ?? null)
  const disabledTuiAgents = useAppStore(
    (s) => s.settings?.disabledTuiAgents ?? DEFAULT_DISABLED_TUI_AGENTS
  )
  const updateSettings = useAppStore((s) => s.updateSettings)
  const nameInputFocusFrameRef = React.useRef<number | null>(null)
  const branchNameInputId = React.useId()
  const submitShortcutModifierLabel = getScreenSubmitModifierLabel()
  const selectedRepoName = React.useMemo(() => {
    const repo = eligibleRepos.find((candidate) => candidate.id === repoId)
    return repo?.displayName ?? repo?.path ?? 'This project'
  }, [eligibleRepos, repoId])
  const selectedProjectName = React.useMemo(() => {
    const option = projectOptions.find((candidate) => candidate.id === selectedProjectId)
    return option?.displayName ?? selectedRepoName
  }, [projectOptions, selectedProjectId, selectedRepoName])
  const sshStatusLabel = selectedRepoSshStatus
    ? getSshStatusLabel(selectedRepoSshStatus)
    : translate('auto.components.NewWorkspaceComposerCard.notConnected', 'Not connected')
  const connectButtonLabel =
    selectedRepoSshStatus === 'disconnected' || selectedRepoSshStatus === null
      ? 'Connect'
      : 'Reconnect'
  const setupConfigLabel =
    setupConfig?.kind === 'default-tabs'
      ? 'Default tab commands'
      : setupConfig?.kind === 'setup-and-default-tabs'
        ? 'Setup and default tab commands'
        : 'Setup script'
  const setupRunLabel =
    setupConfig?.kind === 'default-tabs'
      ? 'Run default tab commands'
      : setupConfig?.kind === 'setup-and-default-tabs'
        ? 'Run setup and default tab commands'
        : 'Run setup command'
  const setupAskLabel =
    setupConfig?.kind === 'default-tabs'
      ? 'Run default tab commands now?'
      : setupConfig?.kind === 'setup-and-default-tabs'
        ? 'Run setup and default tab commands now?'
        : 'Run setup now?'
  const setupRunButtonLabel =
    setupConfig?.kind === 'default-tabs'
      ? 'Run commands now'
      : setupConfig?.kind === 'setup-and-default-tabs'
        ? 'Run commands now'
        : 'Run setup now'
  const setupSkipButtonLabel = setupConfig?.kind === 'setup' ? 'Skip for now' : 'Skip commands'
  // Why: defaultTabs launch commands can run long too, but aren't the setup command this setting gates agent startup on.
  const showSetupAgentStartupPolicy =
    setupControlsEnabled && setupConfig !== null && setupConfig.kind !== 'default-tabs'

  const handleSetDefaultAgent = React.useCallback(
    (next: TuiAgent | 'blank' | null) => {
      updateSettings({ defaultTuiAgent: next })
    },
    [updateSettings]
  )

  const cancelNameInputFocusFrame = React.useCallback((): void => {
    if (nameInputFocusFrameRef.current === null) {
      return
    }
    cancelAnimationFrame(nameInputFocusFrameRef.current)
    nameInputFocusFrameRef.current = null
  }, [])

  const setComposerNode = React.useCallback(
    (node: HTMLDivElement | null): void => {
      // Why: the queued repo-picker focus is only valid while this composer exists.
      if (!node) {
        cancelNameInputFocusFrame()
      }
      if (composerRef) {
        composerRef.current = node
      }
      onComposerNodeChange?.(node)
    },
    [cancelNameInputFocusFrame, composerRef, onComposerNodeChange]
  )

  const focusNameInput = React.useCallback(() => {
    // Why: move focus to the name field after the repo pick so keyboard flow continues instead of trapping in the repo popover.
    cancelNameInputFocusFrame()
    nameInputFocusFrameRef.current = requestAnimationFrame(() => {
      nameInputFocusFrameRef.current = null
      nameInputRef?.current?.focus()
    })
  }, [cancelNameInputFocusFrame, nameInputRef])

  const visibleQuickAgents = React.useMemo(() => {
    const enabledIds = new Set(
      filterEnabledTuiAgents(
        getAgentCatalog().map((agent) => agent.id),
        disabledTuiAgents
      )
    )
    return getAgentCatalog().filter(
      (agent) =>
        enabledIds.has(agent.id) && (detectedAgentIds === null || detectedAgentIds.has(agent.id))
    )
  }, [detectedAgentIds, disabledTuiAgents])

  const handleAddRepo = React.useCallback((): void => {
    // Why: swapping activeModal would unmount the composer, so the override layers Add Project on top instead.
    if (onAddProjectOverride) {
      onAddProjectOverride()
      return
    }
    openModal('add-repo')
  }, [onAddProjectOverride, openModal])
  // Why: open the host-add form inline over the composer (not via Settings) so the user's
  // in-progress workspace form survives; the new host lands in the store and flows straight
  // back into the run-target picker without a navigation round-trip.
  const [addRemoteHostMode, setAddRemoteHostMode] = React.useState<AddRemoteHostMode | null>(null)
  const handleAddSshHost = React.useCallback((): void => {
    setAddRemoteHostMode('ssh')
  }, [])
  const handleAddRemoteServer = React.useCallback((): void => {
    setAddRemoteHostMode('server')
  }, [])
  const [setLocationOption, setSetLocationOption] =
    React.useState<NeedsSetupProjectHostOption | null>(null)
  const handleSetLocation = React.useCallback(
    (option: NeedsSetupProjectHostOption): void => {
      setSetLocationOption(option)
      onNestedDialogOpenChange?.(true)
    },
    [onNestedDialogOpenChange]
  )
  const handleSetLocationClose = React.useCallback((): void => {
    setSetLocationOption(null)
    onNestedDialogOpenChange?.(false)
  }, [onNestedDialogOpenChange])
  const handleSetLocationReady = React.useCallback(
    (setupId: string): void => {
      handleSetLocationClose()
      onProjectHostSetupChange?.(setupId)
    },
    [handleSetLocationClose, onProjectHostSetupChange]
  )
  const projects = useAppStore((state) => state.projects)
  const repos = useAppStore((state) => state.repos)
  const defaultCloneUrl = React.useMemo(
    () => resolveProjectCloneUrlPrefill(projects, repos, selectedProjectId),
    [projects, repos, selectedProjectId]
  )
  const handleConnectRunTargetHost = React.useCallback(
    async (option: NeedsSetupProjectHostOption): Promise<void> => {
      const action = option.connectAction
      if (!action) {
        return
      }
      try {
        if (action.kind === 'ssh') {
          if (isSshConnectInFlight(action.targetId)) {
            return
          }
          // Why: ssh.connect has no built-in timeout; a stalled connect would otherwise leave
          // the row's spinner/disabled state stuck forever. Bound the UI wait — the backend
          // keeps connecting and the picker updates from store SSH state if it later succeeds.
          // The shared registry tracks that backend request (not this bounded wait), so the
          // sidebar card control and terminal overlay for this host stay locked until it
          // settles — a second dial on a passphrase-gated target means a second prompt.
          await withUiConnectTimeout(
            trackSshConnect(action.targetId, window.api.ssh.connect({ targetId: action.targetId }))
          )
          return
        }

        const response = await window.api.runtimeEnvironments.getStatus({
          selector: action.environmentId,
          timeoutMs: 15_000
        })
        const runtimeStatus = unwrapRuntimeRpcResult<RuntimeStatus>(response)
        // Why: the composer button is only a reachability retry; the separate
        // project setup flow remains a follow-up once the host is online.
        useAppStore.getState().setRuntimeEnvironmentStatus(action.environmentId, {
          status: runtimeStatus,
          checkedAt: Date.now()
        })
      } catch (error) {
        if (action.kind === 'runtime') {
          useAppStore.getState().setRuntimeEnvironmentStatus(action.environmentId, {
            status: null,
            checkedAt: Date.now()
          })
        }
        toast.error(
          error instanceof Error
            ? error.message
            : translate(
                'auto.components.NewWorkspaceComposerCard.hostConnectionFailed',
                'Connection failed'
              )
        )
      }
    },
    []
  )
  const handleNotePaste = React.useCallback((event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const text = event.clipboardData.getData('text/plain')
    const byteLengthMeasurement = measureTextControlPasteByteLength(text, {
      stopAfterBytes: TEXT_CONTROL_PASTE_DIRECT_MAX_BYTES
    })
    if (
      !byteLengthMeasurement.exceededLimit &&
      !shouldHandleTextControlPaste(text, { measuredByteLength: byteLengthMeasurement.byteLength })
    ) {
      return
    }

    event.preventDefault()
    event.stopPropagation()
    const textarea = event.currentTarget
    // Why: large note pastes need one controlled owner so React gets a single final input event after chunked DOM insertion.
    void pasteTextIntoTextControl(textarea, text, {
      source: 'clipboard',
      canContinue: (target) => target.ownerDocument.activeElement === target
    })
      .then((result) => {
        if (result.status === 'rejected' && result.reason === 'too-large') {
          toast.error(
            translate(
              'auto.components.NewWorkspaceComposerCard.notePasteTooLarge',
              'Paste is too large for the note field.'
            )
          )
        }
      })
      .catch(() => {})
  }, [])
  const projectDescriptionId = React.useId()
  const readyProjectHostSetupOptions = React.useMemo(
    () => projectHostSetupOptions.filter((option) => option.kind === 'ready'),
    [projectHostSetupOptions]
  )
  const needsSetupProjectHostSetupOptions = React.useMemo(
    () => projectHostSetupOptions.filter((option) => option.kind === 'needs-setup'),
    [projectHostSetupOptions]
  )
  // Why: the picker now also hosts the Add host handoff; even a single ready
  // host needs this affordance for users who have not registered the target yet.
  const shouldShowRunTargetPicker =
    readyProjectHostSetupOptions.length > 0 ||
    ephemeralVmRecipes.length > 0 ||
    needsSetupProjectHostSetupOptions.length > 0
  const handleProjectHostSetupChange = React.useCallback(
    (setupId: string): void => {
      onProjectHostSetupChange?.(setupId)
    },
    [onProjectHostSetupChange]
  )
  useContextualTour(
    'workspace-creation',
    projectOptions.length > 0 && Boolean(selectedProjectId),
    contextualTourSource ??
      (activeModal === 'new-workspace-composer'
        ? 'workspace_creation_modal'
        : 'workspace_creation_visible')
  )

  return (
    <div
      ref={setComposerNode}
      data-workspace-composer-root="true"
      // Why: preload routes native file drops by the nearest data-native-file-drop-target marker, so tag the root to catch card-wide drops.
      data-native-file-drop-target="composer"
      onDragEnter={dragHandlers.onDragEnter}
      onDragLeave={dragHandlers.onDragLeave}
      className={cn(
        'grid min-w-0 gap-1 rounded-md transition',
        isFileDragOver && 'ring-2 ring-ring/30',
        containerClassName
      )}
    >
      <div className="min-w-0 space-y-4 pt-3">
        <div className="space-y-1" data-contextual-tour-target="workspace-creation-project">
          <div className="flex items-center justify-between gap-2">
            <label className="text-xs font-medium text-muted-foreground">
              {projectLabel ??
                translate('auto.components.NewWorkspaceComposerCard.969a8bff66', 'Project')}
            </label>
            {showAddProjectButton ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    onClick={handleAddRepo}
                    className="size-5 shrink-0 rounded-sm text-muted-foreground hover:text-foreground"
                    aria-label={translate(
                      'auto.components.NewWorkspaceComposerCard.d6b0a96f32',
                      'Add project'
                    )}
                  >
                    <FolderPlus className="size-3" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top" sideOffset={6}>
                  {translate('auto.components.NewWorkspaceComposerCard.d6b0a96f32', 'Add project')}
                </TooltipContent>
              </Tooltip>
            ) : null}
          </div>
          <ProjectCombobox
            options={projectOptions}
            value={selectedProjectId}
            onValueChange={onProjectChange}
            onValueSelected={focusNameInput}
            onAddProject={handleAddRepo}
            placeholder={
              projectPlaceholder ??
              translate('auto.components.NewWorkspaceComposerCard.dccd26d4e4', 'Choose project')
            }
            // Why: programmatic .focus() doesn't reliably trigger :focus-visible in Chromium, so mirror the Input ring onto :focus.
            triggerClassName="h-9 w-full border-input text-sm focus:border-ring focus:ring-[3px] focus:ring-ring/50"
            invalid={Boolean(projectError)}
            describedBy={projectDescriptionId}
          />
          {projectError ? (
            <p id={projectDescriptionId} className="text-[11px] text-destructive">
              {projectError}
            </p>
          ) : projectOptions.length === 0 ? (
            <p id={projectDescriptionId} className="text-[11px] text-muted-foreground">
              {emptyProjectMessage ??
                translate(
                  'auto.components.NewWorkspaceComposerCard.addProjectBeforeWorkspace',
                  'Add a project before creating a workspace.'
                )}
            </p>
          ) : null}
          {shouldShowRunTargetPicker ? (
            // Why: Run on is nested in the Project block (so they share the
            // error/empty states), which put it on the block's 4px rhythm. It's
            // its own field, so give it the 16px other fields get.
            <div className="space-y-1 pt-3">
              <label className="block min-w-0 truncate text-xs font-medium text-muted-foreground">
                {translate('auto.components.NewWorkspaceComposerCard.runOn', 'Run on')}
              </label>
              <RunTargetCombobox
                hostOptions={projectHostSetupOptions}
                hostValue={selectedProjectHostSetupId ?? null}
                onHostChange={handleProjectHostSetupChange}
                recipes={ephemeralVmRecipes}
                recipeValue={selectedEphemeralVmRecipeId}
                onRecipeChange={onEphemeralVmRecipeChange}
                onAddSshHost={handleAddSshHost}
                onAddRemoteServer={handleAddRemoteServer}
                onConnectHost={handleConnectRunTargetHost}
                onSetLocation={handleSetLocation}
              />
              {ephemeralVmRecipeError ? (
                <p className="whitespace-pre-line text-[11px] text-destructive">
                  {ephemeralVmRecipeError}
                </p>
              ) : null}
            </div>
          ) : ephemeralVmRecipeError ? (
            <p className="whitespace-pre-line text-[11px] text-destructive">
              {ephemeralVmRecipeError}
            </p>
          ) : null}
          {selectedRepoRequiresConnection && selectedRepoConnectionId ? (
            <div
              role="status"
              aria-live="polite"
              className="flex items-center justify-between gap-3 rounded-md border border-border/70 bg-muted/35 px-3 py-2"
            >
              <div className="min-w-0">
                <div className="truncate text-xs font-medium text-foreground">
                  {translate('auto.components.NewWorkspaceComposerCard.b5a0796911', 'Connect')}{' '}
                  {selectedProjectName}
                </div>
                <div className="mt-0.5 text-[11px] text-muted-foreground">{sshStatusLabel}</div>
              </div>
              <Button
                type="button"
                variant="outline"
                size="xs"
                onClick={() => void onConnectSelectedRepo()}
                disabled={selectedRepoConnectInProgress}
                className="shrink-0"
              >
                {selectedRepoConnectInProgress ? (
                  <LoaderCircle className="size-3.5 animate-spin" />
                ) : (
                  <PlugZap className="size-3.5" />
                )}
                {selectedRepoConnectInProgress
                  ? translate('auto.components.NewWorkspaceComposerCard.f660aa1454', 'Connecting')
                  : connectButtonLabel}
              </Button>
            </div>
          ) : null}
        </div>

        <div className="min-w-0 space-y-1" data-contextual-tour-target="workspace-creation-name">
          <label className="block min-w-0 truncate text-xs font-medium text-muted-foreground">
            {selectedRepoIsGit
              ? translate(
                  'auto.components.NewWorkspaceComposerCard.ac3748dcda',
                  "Name or 'Create From'"
                )
              : translate(
                  'auto.components.NewWorkspaceComposerCard.0ee17638fe',
                  'Workspace name'
                )}{' '}
            <span className="text-muted-foreground/70">
              {translate('auto.components.NewWorkspaceComposerCard.0c5d6a479c', '[Optional]')}
            </span>
          </label>
          <SmartWorkspaceNameField
            inputRef={nameInputRef}
            repos={eligibleRepos}
            repoId={repoId}
            onRepoChange={onRepoChange}
            value={name}
            onValueChange={onNameValueChange}
            onGitHubItemSelect={onSmartGitHubItemSelect}
            onGitLabItemSelect={onSmartGitLabItemSelect}
            onBranchSelect={onSmartBranchSelect}
            onLinearIssueSelect={onSmartLinearIssueSelect}
            onJiraIssueSelect={onSmartJiraIssueSelect}
            onOpenJiraSettings={onOpenJiraSettings}
            selectedSource={smartNameSelection}
            onClearSelectedSource={onClearSmartNameSelection}
            githubSourceContext={smartNameGitHubSourceContext}
            jiraSourceContext={smartNameJiraSourceContext}
            disabled={selectedRepoRequiresConnection}
            disabledPlaceholder={translate(
              'auto.components.NewWorkspaceComposerCard.connectProjectFirst',
              'Connect this project first'
            )}
            textOnly={!selectedRepoIsGit}
            branchesEnabled={branchesEnabled}
            repoBackedSourcesDisabled={repoBackedSourcesDisabled}
            repoBackedSearchRepos={repoBackedSearchRepos}
            allowCrossRepoProjectAdd={allowSmartNameAddProject}
            crossRepoSwitchTarget={smartNameRepoSwitchTarget}
            onActiveSourceModeChange={onSmartNameModeChange}
            onPlainEnter={() => {
              // Why: Enter advances focus to the Agent combobox rather than submitting, keeping keyboard flow through the form.
              const root = composerRef?.current
              const agentTrigger = root?.querySelector<HTMLElement>(
                '[data-agent-combobox-root="true"][role="combobox"]'
              )
              agentTrigger?.focus()
            }}
          />
          {forkPushWarning ? (
            <p className="flex items-start gap-1.5 text-[11px] text-yellow-600 dark:text-yellow-500">
              <AlertTriangle className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
              <span>{forkPushWarning}</span>
            </p>
          ) : null}
          {/* Why (#5181): sits under the branch selection (not Name, which can differ) so reusing the picked branch is an explicit choice. */}
          <div
            className={cn(
              'grid overflow-hidden transition-[grid-template-rows] duration-200 ease-out',
              canReuseSelectedBranch ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
            )}
            aria-hidden={!canReuseSelectedBranch}
          >
            <div className="min-h-0">
              <div className="space-y-1 pt-1">
                <label className="group flex w-fit items-center gap-2 text-xs text-foreground">
                  <span
                    className={cn(
                      'flex size-4 items-center justify-center rounded-[3px] border shadow-sm transition',
                      reuseSelectedBranch
                        ? 'border-emerald-500/60 bg-emerald-500 text-white'
                        : 'border-foreground/20 bg-background dark:border-white/20 dark:bg-muted/10'
                    )}
                  >
                    <Check
                      className={cn(
                        'size-3 transition-opacity',
                        reuseSelectedBranch ? 'opacity-100' : 'opacity-0'
                      )}
                    />
                  </span>
                  <input
                    type="checkbox"
                    checked={reuseSelectedBranch}
                    onChange={(event) => onReuseSelectedBranchChange(event.target.checked)}
                    // Why: row is aria-hidden while collapsed, so disable the input too (no focusable control inside an aria-hidden tree).
                    disabled={!canReuseSelectedBranch}
                    className="sr-only"
                  />
                  <span>
                    {translate(
                      'auto.components.NewWorkspaceComposerCard.reuseExistingBranch',
                      'Reuse branch'
                    )}
                  </span>
                </label>
                <p className="pl-6 text-[11px] text-muted-foreground">
                  {translate(
                    'auto.components.NewWorkspaceComposerCard.reuseExistingBranchHint',
                    'Check out the existing branch instead of creating a new one from it.'
                  )}
                </p>
              </div>
            </div>
          </div>
        </div>

        <div className="min-w-0 space-y-1" data-contextual-tour-target="workspace-creation-agent">
          <div className="flex items-center justify-between gap-2">
            <label className="text-xs font-medium text-muted-foreground">
              {translate('auto.components.NewWorkspaceComposerCard.01d1e8f601', 'Agent')}
            </label>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  onClick={onOpenAgentSettings}
                  // Why: keep Tab flow Name → Agent; tabIndex=-1 so this settings detour doesn't add a keystroke to every creation.
                  tabIndex={-1}
                  className="size-5 shrink-0 rounded-sm text-muted-foreground hover:text-foreground"
                  aria-label={translate(
                    'auto.components.NewWorkspaceComposerCard.ab63f25397',
                    'Open agent settings'
                  )}
                >
                  <Settings2 className="size-3" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={6}>
                {translate(
                  'auto.components.NewWorkspaceComposerCard.ba64270bdb',
                  'Configure agents'
                )}
              </TooltipContent>
            </Tooltip>
          </div>
          <AgentCombobox
            agents={visibleQuickAgents}
            value={quickAgent}
            onValueChange={onQuickAgentChange}
            onOpenManageAgents={onOpenAgentSettings}
            defaultAgent={defaultTuiAgent}
            onSetDefault={handleSetDefaultAgent}
            // Why: match Project/Run-on — full-width form row, no 260px min that can overflow the dialog column.
            allowNarrowTrigger
            triggerClassName="h-9 w-full min-w-0 border-input text-sm focus:border-ring focus:ring-[3px] focus:ring-ring/50"
            onTriggerEnter={createDisabled ? undefined : onCreate}
          />
        </div>

        {/* Why: keep the Advanced disclosure header grouped with the content below while preserving spacing from the Agent field above. */}
        <div className="!mb-2">
          {/* Why: -ml-2 pulls the button so its label aligns flush-left with the field labels above
              while the padded hover highlight extends past the label on the left. The scroll
              container's px-2 inset gives that overhang room so it isn't clipped. */}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onToggleAdvanced}
            className="-ml-2 text-xs focus-visible:ring-inset"
          >
            {translate('auto.components.NewWorkspaceComposerCard.f0470c7383', 'Advanced')}
            <ChevronDown
              className={cn('size-4 transition-transform', advancedOpen && 'rotate-180')}
            />
          </Button>
        </div>

        <div
          className={cn(
            'grid overflow-hidden transition-[grid-template-rows] duration-200 ease-out',
            !advancedOpen && '!mt-2',
            advancedOpen ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
          )}
          aria-hidden={!advancedOpen}
          inert={!advancedOpen}
        >
          <div className="min-h-0">
            {/* Why: px-1 gives the Note textarea's 3px outset focus ring breathing room so the overflow-hidden drawer doesn't clip it. */}
            <div
              className={cn(
                'space-y-4 px-1 pt-1 pb-3 transition-[opacity,transform] duration-150 ease-out',
                advancedOpen
                  ? 'translate-y-0 opacity-100 delay-200'
                  : '-translate-y-1 opacity-0 delay-0'
              )}
            >
              {smartNameSelection ? (
                // Why: with a source pill the smart field isn't editable, so surface the derived name here; a typed name already is the name field.
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground">
                    {translate('auto.components.NewWorkspaceComposerCard.2688050e4b', 'Name')}
                  </label>
                  <input
                    type="text"
                    value={name}
                    onChange={(event) => onNameValueChange(event.target.value)}
                    placeholder={translate(
                      'auto.components.NewWorkspaceComposerCard.0ee17638fe',
                      'Workspace name'
                    )}
                    className="w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-1.5 text-sm shadow-xs transition-[color,box-shadow] outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                  />
                </div>
              ) : null}

              {/* Why: for a tracked work item (PR/issue/MR/Linear) the branch is derived from the item, so a manual override here would be silently ignored. */}
              {selectedRepoIsGit &&
              branchesEnabled &&
              (!smartNameSelection || smartNameSelection.kind === 'branch') ? (
                <div className="space-y-1">
                  <label
                    htmlFor={branchNameInputId}
                    className="text-xs font-medium text-muted-foreground"
                  >
                    {translate(
                      'auto.components.NewWorkspaceComposerCard.branchName',
                      'Branch name'
                    )}
                  </label>
                  <input
                    id={branchNameInputId}
                    type="text"
                    value={branchNameOverride ?? ''}
                    onChange={(event) => onBranchNameOverrideChange(event.target.value)}
                    placeholder={translate(
                      'auto.components.NewWorkspaceComposerCard.branchNamePlaceholder',
                      'feature/my-branch'
                    )}
                    className="w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-1.5 text-sm shadow-xs transition-[color,box-shadow] outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                  />
                </div>
              ) : null}

              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">
                  {translate('auto.components.NewWorkspaceComposerCard.f8728aa4f9', 'Note')}
                </label>
                <textarea
                  value={note}
                  onChange={(event) => onNoteChange(event.target.value)}
                  onPaste={handleNotePaste}
                  placeholder={translate(
                    'auto.components.NewWorkspaceComposerCard.090cfedeb4',
                    'Write a note'
                  )}
                  rows={1}
                  // Why (#10575): field-sizing:content grows the note with its value, so a PR/MR
                  // prefill written straight to state sizes like typed text — an onInput measure
                  // pass never saw it. Past the max-h clamp the sleek scrollbar keeps it readable.
                  className="w-full min-w-0 resize-none overflow-y-auto scrollbar-sleek rounded-md border border-input bg-transparent px-3 py-1.5 text-sm shadow-xs transition-[color,box-shadow] outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 [field-sizing:content] max-h-40"
                />
              </div>

              {setupControlsEnabled && setupConfig ? (
                <div className="space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <label className="text-xs font-medium text-muted-foreground">
                      {setupConfigLabel}
                    </label>
                    {/* Why: a quiet monospace filename chip (not an uppercase tag) — orca.yaml is a
                        literal filename, so it reads as code, matching the app's path styling. */}
                    <span className="rounded border border-border/50 bg-muted/30 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                      {setupConfig.source === 'yaml'
                        ? translate(
                            'auto.components.NewWorkspaceComposerCard.23bb365554',
                            'orca.yaml'
                          )
                        : setupConfig.source === 'both'
                          ? translate(
                              'auto.components.NewWorkspaceComposerCard.326a578923',
                              'orca.yaml + local'
                            )
                          : translate(
                              'auto.components.NewWorkspaceComposerCard.92e34f0311',
                              'local settings'
                            )}
                    </span>
                  </div>

                  {/* Why: `orca.yaml` is the committed source of truth for shared setup,
                      so the preview reconstructs the real YAML shape instead of showing a raw
                      shell blob that hides where the command came from. */}
                  <SetupCommandPreview setupConfig={setupConfig} />

                  {/* Why: group the run-setup and wait-for-setup toggles in one bordered box so
                      they read as a single settings cluster, aligned hard-right. */}
                  {!requiresExplicitSetupChoice || showSetupAgentStartupPolicy ? (
                    <div className="rounded-md border border-border/60 bg-muted/25">
                      {requiresExplicitSetupChoice ? null : (
                        <div className="flex items-center justify-between gap-3 p-3">
                          <span className="text-xs font-medium text-foreground">
                            {setupRunLabel}
                          </span>
                          <SettingsSwitch
                            checked={resolvedSetupDecision === 'run'}
                            onChange={() =>
                              onSetupDecisionChange(
                                resolvedSetupDecision === 'run' ? 'skip' : 'run'
                              )
                            }
                            ariaLabel={setupRunLabel}
                          />
                        </div>
                      )}
                      {showSetupAgentStartupPolicy ? (
                        // Why: nothing to wait for when setup won't run — disable the toggle and
                        // dim the label so it reads as inactive (the switch dims itself).
                        <div className="flex items-start justify-between gap-3 p-3">
                          <span
                            className={cn(
                              'min-w-0 space-y-1',
                              resolvedSetupDecision === 'run' ? '' : 'opacity-50'
                            )}
                          >
                            <span className="block text-xs font-medium text-foreground">
                              {translate(
                                'auto.components.NewWorkspaceComposerCard.waitForSetupBeforeAgent',
                                'Wait for setup to complete before starting agent'
                              )}
                            </span>
                            <span className="block text-[11px] text-muted-foreground">
                              {translate(
                                'auto.components.NewWorkspaceComposerCard.waitForSetupBeforeAgentHelp',
                                'Turn this on when setup installs dependencies, MCP servers, or config files the agent needs during startup.'
                              )}
                            </span>
                          </span>
                          <SettingsSwitch
                            checked={setupAgentStartupPolicy === 'wait-for-setup'}
                            disabled={resolvedSetupDecision !== 'run'}
                            onChange={() =>
                              onSetupAgentStartupPolicyChange(
                                setupAgentStartupPolicy === 'wait-for-setup'
                                  ? 'start-immediately'
                                  : 'wait-for-setup'
                              )
                            }
                            ariaLabel={translate(
                              'auto.components.NewWorkspaceComposerCard.waitForSetupBeforeAgent',
                              'Wait for setup to complete before starting agent'
                            )}
                          />
                        </div>
                      ) : null}
                    </div>
                  ) : null}

                  {requiresExplicitSetupChoice ? (
                    <div className="space-y-2">
                      <div className="text-[11px] font-medium text-muted-foreground">
                        {setupAskLabel}
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <Button
                          type="button"
                          onClick={() => onSetupDecisionChange('run')}
                          variant={setupDecision === 'run' ? 'default' : 'outline'}
                          size="sm"
                        >
                          {setupRunButtonLabel}
                        </Button>
                        <Button
                          type="button"
                          onClick={() => onSetupDecisionChange('skip')}
                          variant={setupDecision === 'skip' ? 'secondary' : 'outline'}
                          size="sm"
                        >
                          {setupSkipButtonLabel}
                        </Button>
                      </div>
                      {!setupDecision ? (
                        <div className="text-xs text-muted-foreground">
                          {shouldWaitForSetupCheck
                            ? translate(
                                'auto.components.NewWorkspaceComposerCard.803b7fe72f',
                                'Checking setup configuration...'
                              )
                            : translate(
                                'auto.components.NewWorkspaceComposerCard.9a70e4859e',
                                'Choose whether to run setup before creating this workspace.'
                              )}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              ) : null}

              {sparseControlsEnabled ? (
                <div className="space-y-1.5">
                  <label className="text-xs font-medium text-muted-foreground">
                    {translate(
                      'auto.components.NewWorkspaceComposerCard.d861de981b',
                      'Sparse checkout'
                    )}
                  </label>
                  <SparseCheckoutPresetSelect
                    repoId={repoId}
                    presets={sparsePresets}
                    selectedPresetId={sparseSelectedPresetId}
                    onSelectPreset={onSparseSelectPreset}
                    disabled={!canUseSparseCheckout}
                  />
                  {!canUseSparseCheckout ? (
                    <p className="text-[11px] text-muted-foreground">
                      {translate(
                        'auto.components.NewWorkspaceComposerCard.cbb47ee0dc',
                        'Only available for local Git projects.'
                      )}
                    </p>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </div>

      {createError ? (
        <div
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          {createError.help ? (
            <div className="space-y-1">
              <p className="font-medium">{createError.title}</p>
              <p>{createError.message}</p>
              <p className="text-destructive/85">{createError.help}</p>
            </div>
          ) : (
            createError.message
          )}
        </div>
      ) : null}

      <div
        className={cn(
          'flex items-center gap-3',
          showCreateMultiple ? 'justify-between' : 'justify-end'
        )}
      >
        {showCreateMultiple ? (
          <button
            type="button"
            role="switch"
            aria-checked={createMultiple}
            onClick={() => onCreateMultipleChange?.(!createMultiple)}
            className="group flex w-fit cursor-pointer items-center gap-2 rounded-md text-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            <SwitchIndicator checked={createMultiple} />
            <span className="text-muted-foreground transition-colors group-hover:text-foreground">
              {translate('auto.components.NewWorkspaceComposerCard.createMultiple', 'Create more')}
            </span>
          </button>
        ) : null}
        <Button
          onClick={() => void onCreate()}
          disabled={createDisabled}
          size="sm"
          className="text-xs"
        >
          {creating ? <LoaderCircle className="size-4 animate-spin" /> : null}
          {primaryActionLabel}
          <span className="ml-1 inline-flex items-center gap-0.5 rounded border border-white/20 px-1.5 py-0.5 text-[10px] font-medium leading-none text-current/80">
            <span>{submitShortcutModifierLabel}</span>
            <CornerDownLeft className="size-3" />
          </span>
        </Button>
      </div>
      {/* Why: layer the host-add form over the composer instead of navigating to Settings so
          the in-progress workspace form is preserved; on success the new host flows back into
          the run-target picker via the store. */}
      <AddRemoteHostDialog mode={addRemoteHostMode} onOpenChange={setAddRemoteHostMode} />
      <SetProjectLocationDialog
        option={setLocationOption}
        projectName={selectedProjectName}
        projectKind={selectedRepoIsGit ? 'git' : 'folder'}
        defaultCloneUrl={defaultCloneUrl}
        onClose={handleSetLocationClose}
        onReady={handleSetLocationReady}
      />
    </div>
  )
}
