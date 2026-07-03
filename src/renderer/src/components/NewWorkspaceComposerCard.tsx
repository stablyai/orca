/* eslint-disable max-lines -- Why: this component intentionally keeps the full
composer card markup together so the inline and modal variants share one UI
surface without splitting the controlled form into hard-to-follow fragments. */
import React from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsUpDown,
  Cloud,
  CornerDownLeft,
  FolderPlus,
  LoaderCircle,
  PlugZap,
  Settings2,
  Server
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Command, CommandEmpty, CommandItem, CommandList } from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { SettingsSwitch } from '@/components/settings/SettingsFormControls'
import type RepoCombobox from '@/components/repo/RepoCombobox'
import AgentCombobox from '@/components/agent/AgentCombobox'
import { getAgentCatalog } from '@/lib/agent-catalog'
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
import { filterEnabledTuiAgents } from '../../../shared/tui-agent-selection'
import type {
  GitHubWorkItem,
  GitLabWorkItem,
  LinearIssue,
  SetupAgentStartupPolicy,
  OrcaHooks,
  SparsePreset,
  TuiAgent
} from '../../../shared/types'
import SparseCheckoutPresetSelect from '@/components/sparse/SparseCheckoutPresetSelect'
import SmartWorkspaceNameField, {
  type SmartWorkspaceNameSelection
} from '@/components/new-workspace/SmartWorkspaceNameField'
import ProjectCombobox from '@/components/new-workspace/ProjectCombobox'
import type { SetupConfig } from '@/lib/new-workspace'
import type { NewWorkspaceProjectOption } from '@/lib/new-workspace-project-options'
import type {
  ProjectHostSetupOption,
  ReadyProjectHostSetupOption
} from '@/lib/project-host-setup-options'
import type { WorkspaceCreateErrorDisplay } from '@/lib/workspace-create-error-format'
import type { SshConnectionStatus } from '../../../shared/ssh-types'
import type { TaskSourceContext } from '../../../shared/task-source-context'
import { translate } from '@/i18n/i18n'

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
  eligibleRepos: RepoOption[]
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
  repoBackedSearchRepos?: RepoOption[]
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
  onSmartLinearIssueSelect: (issue: LinearIssue) => void
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

function getRecipeCommandDisplay(command: string): string {
  const trimmed = command.trim()
  const quoted = trimmed.match(/^"([^"]+)"/) ?? trimmed.match(/^'([^']+)'/)
  return quoted?.[1] ?? trimmed.split(/\s+/)[0] ?? trimmed
}

function getRecipeDestroyLabel(recipe: EphemeralVmRecipeOption): string {
  if (recipe.destroyDisabled) {
    return translate('auto.components.NewWorkspaceComposerCard.destroyDisabled', 'destroy disabled')
  }
  if (recipe.destroy) {
    return translate(
      'auto.components.NewWorkspaceComposerCard.destroyConfigured',
      'destroy configured'
    )
  }
  return translate('auto.components.NewWorkspaceComposerCard.noDestroyConfigured', 'no destroy')
}

type WorkspaceRunTargetComboboxProps = {
  hostOptions: readonly ReadyProjectHostSetupOption[]
  hostValue: string | null
  onHostChange?: (setupId: string) => void
  recipes: EphemeralVmRecipeOption[]
  recipeValue: string | null
  onRecipeChange?: (recipeId: string | null) => void
}

function WorkspaceRunTargetCombobox({
  hostOptions,
  hostValue,
  onHostChange,
  recipes,
  recipeValue,
  onRecipeChange
}: WorkspaceRunTargetComboboxProps): React.JSX.Element {
  const [open, setOpen] = React.useState(false)
  const [vmRecipesOpen, setVmRecipesOpen] = React.useState(false)
  const selectedHost =
    hostOptions.find((option) => option.id === hostValue) ?? hostOptions[0] ?? null
  const selectedRecipe = recipes.find((recipe) => recipe.id === recipeValue) ?? null
  const selectedValue = selectedRecipe
    ? `recipe:${selectedRecipe.id}`
    : selectedHost
      ? `host:${selectedHost.id}`
      : ''
  const ephemeralVmLabel = translate(
    'auto.components.NewWorkspaceComposerCard.ephemeralVm',
    'Per-Workspace Environment'
  )

  const handleHostSelect = React.useCallback(
    (setupId: string): void => {
      if (!hostOptions.some((candidate) => candidate.id === setupId)) {
        return
      }
      onHostChange?.(setupId)
      onRecipeChange?.(null)
      setOpen(false)
    },
    [hostOptions, onHostChange, onRecipeChange]
  )

  const handleRecipeSelect = React.useCallback(
    (recipeId: string): void => {
      if (!recipes.some((recipe) => recipe.id === recipeId)) {
        return
      }
      onRecipeChange?.(recipeId)
      setVmRecipesOpen(false)
      setOpen(false)
    },
    [onRecipeChange, recipes]
  )

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="h-9 w-full justify-between border-input px-3 text-sm font-normal focus:border-ring focus:ring-[3px] focus:ring-ring/50"
        >
          {selectedRecipe ? (
            <span className="inline-flex min-w-0 items-center gap-1.5">
              <Cloud className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate">
                {ephemeralVmLabel} / {selectedRecipe.name}
              </span>
            </span>
          ) : selectedHost ? (
            <span className="inline-flex min-w-0 items-center gap-1.5">
              <Server className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate">{selectedHost.label}</span>
            </span>
          ) : (
            <span className="text-muted-foreground">
              {translate(
                'auto.components.NewWorkspaceComposerCard.chooseRunTarget',
                'Choose target'
              )}
            </span>
          )}
          <ChevronsUpDown className="size-3.5 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[var(--radix-popover-trigger-width)] min-w-[18rem] p-0"
      >
        <Command value={selectedValue}>
          <CommandList>
            <CommandEmpty>
              {translate(
                'auto.components.NewWorkspaceComposerCard.noRunTargets',
                'No run targets are ready for this project.'
              )}
            </CommandEmpty>
            {hostOptions.map((option) => (
              <CommandItem
                key={option.id}
                value={`host:${option.id}`}
                onSelect={() => handleHostSelect(option.id)}
                className="items-center gap-2 px-3 py-2"
              >
                <Check
                  className={cn(
                    'size-4 text-foreground',
                    !selectedRecipe && option.id === selectedHost?.id ? 'opacity-100' : 'opacity-0'
                  )}
                />
                <Server className="size-3.5 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm">{option.label}</div>
                  <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
                    {option.path}
                  </div>
                </div>
              </CommandItem>
            ))}
            {recipes.length > 0 ? (
              <Popover open={vmRecipesOpen} onOpenChange={setVmRecipesOpen}>
                <PopoverTrigger asChild>
                  {/* Why: a real CommandItem (not a raw button) so cmdk registers it — fixes the row
                      only rendering under the first host, the uneven height, and the double-highlight. */}
                  <CommandItem
                    value="per-workspace-env"
                    onSelect={() => setVmRecipesOpen(true)}
                    className="items-center gap-2 px-3 py-2"
                  >
                    <Check
                      className={cn(
                        'size-4 text-foreground',
                        selectedRecipe ? 'opacity-100' : 'opacity-0'
                      )}
                    />
                    <Cloud className="size-3.5 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm">{ephemeralVmLabel}</div>
                      {/* Why: a second line so this row matches the two-line height of the host
                          options above, and to hint what choosing it opens. */}
                      <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
                        {translate(
                          'auto.components.NewWorkspaceComposerCard.perWorkspaceEnvHint',
                          'Provision an on-demand environment from a recipe'
                        )}
                      </div>
                    </div>
                    <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
                  </CommandItem>
                </PopoverTrigger>
                <PopoverContent side="right" align="start" sideOffset={6} className="w-72 p-0">
                  <Command value={selectedRecipe ? `recipe:${selectedRecipe.id}` : ''}>
                    <CommandList>
                      {recipes.map((recipe) => (
                        <CommandItem
                          key={recipe.id}
                          value={`recipe:${recipe.id}`}
                          onSelect={() => handleRecipeSelect(recipe.id)}
                          className="items-center gap-2 px-3 py-2"
                        >
                          <Check
                            className={cn(
                              'size-4 text-foreground',
                              recipe.id === selectedRecipe?.id ? 'opacity-100' : 'opacity-0'
                            )}
                          />
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-sm">{recipe.name}</div>
                            <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
                              {getRecipeCommandDisplay(recipe.create)} ·{' '}
                              {getRecipeDestroyLabel(recipe)}
                            </div>
                            {recipe.description ? (
                              <div className="truncate text-[11px] text-muted-foreground">
                                {recipe.description}
                              </div>
                            ) : null}
                          </div>
                        </CommandItem>
                      ))}
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>
            ) : null}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

function SetupCommandPreview({
  setupConfig,
  headerAction
}: {
  setupConfig: SetupConfig
  headerAction?: React.ReactNode
}): React.JSX.Element {
  if (setupConfig.source === 'yaml') {
    return (
      <div className="rounded-2xl border border-border/60 bg-muted/40 shadow-inner">
        <div className="flex items-center justify-between gap-3 border-b border-border/60 px-4 py-2.5">
          <div className="font-mono text-[11px] text-muted-foreground">
            {translate('auto.components.NewWorkspaceComposerCard.23bb365554', 'orca.yaml')}
          </div>
          {headerAction}
        </div>
        {/* Why: long orca.yaml scripts must not grow the create dialog past the viewport. */}
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words px-4 py-3 font-mono text-[12px] leading-5 text-emerald-700 scrollbar-sleek dark:text-emerald-300/95">
          {setupConfig.command}
        </pre>
      </div>
    )
  }

  return (
    <div className="rounded-2xl border border-border/60 bg-muted/35 px-4 py-3 shadow-inner">
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
          {setupConfig.source === 'both'
            ? translate(
                'auto.components.NewWorkspaceComposerCard.e5db1b0419',
                'Combined setup command'
              )
            : translate(
                'auto.components.NewWorkspaceComposerCard.7711ad5122',
                'Local setup command'
              )}
        </div>
        {headerAction}
      </div>
      <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-[12px] leading-5 text-foreground scrollbar-sleek">
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
    // Why: "Files" is the DataTransfer type the OS adds for native file drags;
    // internal in-app drags must not trigger the
    // attachment-drop highlight so they still route to their own handlers.
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
      // Why: mirror the onDragEnter guard so internal in-app drags (which may
      // carry both "Files" and the workspace path MIME type) don't decrement
      // the counter when enter skipped incrementing it — otherwise the counter
      // goes negative and the native-drag highlight state desyncs.
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

  // Why: the preload bridge calls stopPropagation on native `drop` events so
  // React's onDrop never fires on the composer card. Listen at the document
  // level (also capture-phase) to reset the drag highlight whenever any drop
  // or dragend occurs anywhere in the window.
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
  onSmartLinearIssueSelect,
  smartNameSelection,
  onClearSmartNameSelection,
  canReuseSelectedBranch,
  reuseSelectedBranch,
  onReuseSelectedBranchChange,
  showCreateMultiple = false,
  createMultiple = false,
  onCreateMultipleChange,
  smartNameGitHubSourceContext,
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
  sparseControlsEnabled = true
}: NewWorkspaceComposerCardProps): React.JSX.Element {
  // Why: this form uses the lightweight translate() helper directly; subscribe
  // so an already-open create dialog repaints when the UI language changes.
  useTranslation()
  const { isFileDragOver, dragHandlers } = useComposerFileDragOver()
  const openModal = useAppStore((s) => s.openModal)
  const activeModal = useAppStore((s) => s.activeModal)
  const defaultTuiAgent = useAppStore((s) => s.settings?.defaultTuiAgent ?? null)
  const disabledTuiAgents = useAppStore((s) => s.settings?.disabledTuiAgents ?? [])
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
  // Why: defaultTabs launch commands can be long-running too, but they are not
  // the setup command this setting gates agent startup on.
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
    // Why: after the repo picker commits a choice, moving focus to the name
    // field keeps the keyboard flow progressing through the form instead of
    // trapping the user in the repo popover interaction.
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
    openModal('add-repo')
  }, [openModal])
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
    // Why: large note pastes need one controlled owner so React receives a
    // single final input event after chunked DOM insertion.
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
      // Why: preload classifies native OS file drops by the nearest
      // `data-native-file-drop-target` marker in the composedPath. Tagging
      // the composer root makes drops anywhere on the card route to the
      // composer attachment handler instead of falling back to the default
      // editor-open behavior.
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
            placeholder={
              projectPlaceholder ??
              translate('auto.components.NewWorkspaceComposerCard.dccd26d4e4', 'Choose project')
            }
            // Why: programmatic .focus() does not reliably trigger
            // :focus-visible in Chromium. Mirror the Input component's
            // standard ring (border-ring + ring-ring/50, 3px) onto :focus so
            // keyboard navigation paints the familiar field ring.
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
          {readyProjectHostSetupOptions.length > 1 || ephemeralVmRecipes.length > 0 ? (
            <div className="space-y-1">
              <label className="block min-w-0 truncate text-xs font-medium text-muted-foreground">
                {translate('auto.components.NewWorkspaceComposerCard.runOn', 'Run on')}
              </label>
              <WorkspaceRunTargetCombobox
                hostOptions={readyProjectHostSetupOptions}
                hostValue={selectedProjectHostSetupId ?? null}
                onHostChange={handleProjectHostSetupChange}
                recipes={ephemeralVmRecipes}
                recipeValue={selectedEphemeralVmRecipeId}
                onRecipeChange={onEphemeralVmRecipeChange}
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
            selectedSource={smartNameSelection}
            onClearSelectedSource={onClearSmartNameSelection}
            githubSourceContext={smartNameGitHubSourceContext}
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
            onPlainEnter={() => {
              // Why: Enter on the workspace name advances focus to the next
              // field (Agent combobox) rather than submitting, letting the user
              // progress through the form with just the keyboard.
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
          {/* Why (#5181): sits right under the branch selection (not the Name
              field, which can differ from the branch) so reusing the picked
              branch is an explicit, discoverable choice. Stays mounted and
              collapses via a grid-rows transition (matching the Advanced
              drawer) so the dialog grows/shrinks smoothly as the option
              appears. Only offered when reuse is possible — an existing local
              branch not already checked out in another worktree. */}
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
                    // Why: while collapsed the row is aria-hidden, so disable the
                    // input too — keeps a hidden control out of the tab order and
                    // fully inert (no focusable control inside an aria-hidden tree).
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

        <div className="space-y-1" data-contextual-tour-target="workspace-creation-agent">
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
                  // Why: keep Tab flow Name → Agent combobox. This settings
                  // shortcut is a detour; making it tabbable forces a keystroke
                  // on every workspace creation.
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
            triggerClassName="h-9 w-full border-input text-sm focus:border-ring focus:ring-[3px] focus:ring-ring/50"
            onTriggerEnter={createDisabled ? undefined : onCreate}
          />
        </div>

        {/* Why: Advanced is a disclosure header, so keep it visually grouped
            with the content or footer below it while preserving normal spacing
            from the Agent field above. */}
        <div className="!mb-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onToggleAdvanced}
            className="-ml-2 text-xs"
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
        >
          <div className="min-h-0">
            {/* Why: px-1 insets the content 4px on each side so the Note
                textarea's 3px outset focus ring has horizontal breathing room
                inside the overflow-hidden drawer above. Without it the ring
                gets clipped on the right edge when the field is focused. */}
            <div
              className={cn(
                'space-y-4 px-1 pt-1 pb-3 transition-[opacity,transform] duration-150 ease-out',
                advancedOpen
                  ? 'translate-y-0 opacity-100 delay-200'
                  : '-translate-y-1 opacity-0 delay-0'
              )}
            >
              {smartNameSelection ? (
                // Why: when a source (PR/issue/Linear/Jira/branch) is picked the
                // smart field shows a pill instead of an editable name, so
                // surface the auto-derived workspace name here under Advanced
                // where it can be reviewed/overridden. When the user typed an
                // explicit name there's no source pill — the smart input is
                // already the name field, so we don't duplicate it here.
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

              {/* Why: only offer a manual branch name when creating from a
                  typed name or a base branch. When a tracked work item (PR/
                  issue/MR/Linear) is the source, the branch is derived from
                  that item — a linked GitHub PR even re-resolves it at submit —
                  so an override typed here would be silently ignored. */}
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
                  onInput={(event) => {
                    // Why: start at one-line height, grow to fit content so a short
                    // note keeps the dialog compact while longer notes get room to
                    // breathe without a scroll bar until the max-h clamps growth.
                    const ta = event.currentTarget
                    ta.style.height = 'auto'
                    ta.style.height = `${ta.scrollHeight}px`
                  }}
                  placeholder={translate(
                    'auto.components.NewWorkspaceComposerCard.090cfedeb4',
                    'Write a note'
                  )}
                  rows={1}
                  className="w-full min-w-0 resize-none overflow-hidden rounded-md border border-input bg-transparent px-3 py-1.5 text-sm shadow-xs transition-[color,box-shadow] outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 max-h-40"
                />
              </div>

              {setupControlsEnabled && setupConfig ? (
                <div className="space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <label className="text-xs font-medium text-muted-foreground">
                      {setupConfigLabel}
                    </label>
                    <span className="rounded-full border border-border/70 bg-muted/45 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.14em] text-foreground/70">
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
                  <SetupCommandPreview
                    setupConfig={setupConfig}
                    headerAction={
                      requiresExplicitSetupChoice ? null : (
                        <label className="group flex items-center gap-2 text-xs text-foreground">
                          <span
                            className={cn(
                              'flex size-4 items-center justify-center rounded-[3px] border transition shadow-sm',
                              resolvedSetupDecision === 'run'
                                ? 'border-emerald-500/60 bg-emerald-500 text-white'
                                : 'border-foreground/20 bg-background dark:border-white/20 dark:bg-muted/10'
                            )}
                          >
                            <Check
                              className={cn(
                                'size-3 transition-opacity',
                                resolvedSetupDecision === 'run' ? 'opacity-100' : 'opacity-0'
                              )}
                            />
                          </span>
                          <input
                            type="checkbox"
                            checked={resolvedSetupDecision === 'run'}
                            onChange={(event) =>
                              onSetupDecisionChange(event.target.checked ? 'run' : 'skip')
                            }
                            className="sr-only"
                          />
                          <span>{setupRunLabel}</span>
                        </label>
                      )
                    }
                  />

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

                  {showSetupAgentStartupPolicy ? (
                    <div className="flex items-start justify-between gap-3 rounded-md border border-border/60 bg-muted/25 p-3">
                      <span className="min-w-0 space-y-1">
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
            <span
              aria-hidden
              className={cn(
                'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-transparent transition-colors',
                createMultiple ? 'bg-foreground' : 'bg-muted-foreground/30'
              )}
            >
              <span
                className={cn(
                  'pointer-events-none block size-3.5 rounded-full bg-background shadow-sm transition-transform',
                  createMultiple ? 'translate-x-4' : 'translate-x-0.5'
                )}
              />
            </span>
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
    </div>
  )
}
