/* eslint-disable max-lines -- Why: keep the full composer card markup together so the inline and modal variants share one UI surface. */
import React from 'react'
import { createPortal } from 'react-dom'
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
  Monitor,
  PlugZap,
  Plus,
  Settings2,
  Server
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandItem,
  CommandList,
  CommandSeparator
} from '@/components/ui/command'
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
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
import type { SmartNameMode } from '@/components/new-workspace/smart-workspace-source-results'
import ProjectCombobox from '@/components/new-workspace/ProjectCombobox'
import {
  AddRemoteHostDialog,
  type AddRemoteHostMode
} from '@/components/sidebar/AddRemoteHostDialog'
import type { SetupConfig } from '@/lib/new-workspace'
import type { NewWorkspaceProjectOption } from '@/lib/new-workspace-project-options'
import type {
  NeedsSetupProjectHostOption,
  ProjectHostSetupOption,
  ReadyProjectHostSetupOption
} from '@/lib/project-host-setup-options'
import type { WorkspaceCreateErrorDisplay } from '@/lib/workspace-create-error-format'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../shared/execution-host'
import type { SshConnectionStatus } from '../../../shared/ssh-types'
import type { TaskSourceContext } from '../../../shared/task-source-context'
import type { RuntimeStatus } from '../../../shared/runtime-types'
import { unwrapRuntimeRpcResult } from '@/runtime/runtime-rpc-client'
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
  onSmartNameModeChange?: (mode: SmartNameMode) => void
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
  /** When set, "Add project" opens a host-provided flow instead of swapping the store's active modal. */
  onAddProjectOverride?: () => void
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

// Why: bound how long the run-target picker waits on a host connect so a stalled backend
// connect can't leave the row's disabled/spinner state stuck forever. The backend keeps going.
const RUN_TARGET_CONNECT_UI_TIMEOUT_MS = 20_000

async function withUiConnectTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(
          translate(
            'auto.components.NewWorkspaceComposerCard.connectTimedOut',
            'Connection timed out. It may still be connecting in the background.'
          )
        )
      )
    }, RUN_TARGET_CONNECT_UI_TIMEOUT_MS)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer) {
      clearTimeout(timer)
    }
  }
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
  hostOptions: readonly ProjectHostSetupOption[]
  hostValue: string | null
  onHostChange?: (setupId: string) => void
  recipes: EphemeralVmRecipeOption[]
  recipeValue: string | null
  onRecipeChange?: (recipeId: string | null) => void
  onAddRemoteServer?: () => void
  onAddSshHost?: () => void
  onConnectHost?: (option: NeedsSetupProjectHostOption) => Promise<void> | void
}

type HostPathTooltipPosition = {
  left: number
  top: number
  maxWidth: number
}

const HOST_PATH_TOOLTIP_DELAY_MS = 400
const HOST_PATH_TOOLTIP_VIEWPORT_GAP_PX = 8
const HOST_PATH_TOOLTIP_TRIGGER_GAP_PX = 4

function HostPathTooltip({ path }: { path: string }): React.JSX.Element {
  const tooltipId = React.useId()
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const pointerInsideRef = React.useRef(false)
  const [position, setPosition] = React.useState<HostPathTooltipPosition | null>(null)

  const hideTooltip = React.useCallback((): void => {
    pointerInsideRef.current = false
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    setPosition(null)
  }, [])

  React.useEffect(() => hideTooltip, [hideTooltip])

  const handlePointerEnter = React.useCallback((event: React.PointerEvent<HTMLElement>): void => {
    pointerInsideRef.current = true
    const trigger = event.currentTarget
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current)
    }
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      if (!pointerInsideRef.current || !trigger.isConnected) {
        return
      }
      const rect = trigger.getBoundingClientRect()
      // Why: anchor under the hovered path, capping width to the viewport edge so a long path wraps instead of flying off-screen.
      const left = Math.max(HOST_PATH_TOOLTIP_VIEWPORT_GAP_PX, rect.left)
      setPosition({
        left,
        top: rect.bottom + HOST_PATH_TOOLTIP_TRIGGER_GAP_PX,
        maxWidth: window.innerWidth - left - HOST_PATH_TOOLTIP_VIEWPORT_GAP_PX
      })
    }, HOST_PATH_TOOLTIP_DELAY_MS)
  }, [])

  return (
    <>
      {/* Trigger is the truncated path line itself, so the tooltip only appears when hovering it. */}
      <div
        className="mt-0.5 truncate text-[11px] text-muted-foreground"
        aria-describedby={position ? tooltipId : undefined}
        onPointerEnter={handlePointerEnter}
        onPointerLeave={hideTooltip}
        onPointerDown={hideTooltip}
      >
        {path}
      </div>
      {/* Why: a fixed, pointer-transparent portal cannot reflow cmdk or become the hover target. */}
      {position
        ? createPortal(
            <div
              id={tooltipId}
              role="tooltip"
              data-slot="host-path-tooltip"
              className="pointer-events-none fixed z-[100] w-max break-all rounded-sm border border-border bg-popover px-1.5 py-1 font-mono text-[11px] leading-tight text-popover-foreground shadow-xs"
              style={{ left: position.left, top: position.top, maxWidth: position.maxWidth }}
            >
              {path}
            </div>,
            document.body
          )
        : null}
    </>
  )
}

// Why: the local machine isn't a server — give it a monitor glyph so it reads as "this computer".
function HostRowIcon({ hostId }: { hostId: ExecutionHostId }): React.JSX.Element {
  const Icon = hostId === LOCAL_EXECUTION_HOST_ID ? Monitor : Server
  return <Icon className="size-3.5 shrink-0 text-muted-foreground" />
}

function WorkspaceRunTargetCombobox({
  hostOptions,
  hostValue,
  onHostChange,
  recipes,
  recipeValue,
  onRecipeChange,
  onAddRemoteServer,
  onAddSshHost,
  onConnectHost
}: WorkspaceRunTargetComboboxProps): React.JSX.Element {
  const [open, setOpen] = React.useState(false)
  const [vmRecipesOpen, setVmRecipesOpen] = React.useState(false)
  const [hostActionsOpen, setHostActionsOpen] = React.useState(false)
  // Why: track in-flight connects per host (a Set, not a single id) so connecting one host — or
  // one connect stalling — never disables connecting to the others.
  const [connectingHostIds, setConnectingHostIds] = React.useState<ReadonlySet<string>>(
    () => new Set()
  )
  const readyHostOptions = React.useMemo(
    () =>
      hostOptions.filter(
        (option): option is ReadyProjectHostSetupOption => option.kind === 'ready'
      ),
    [hostOptions]
  )
  const needsSetupHostOptions = React.useMemo(
    () =>
      hostOptions.filter(
        (option): option is NeedsSetupProjectHostOption => option.kind === 'needs-setup'
      ),
    [hostOptions]
  )
  const selectedHost =
    readyHostOptions.find((option) => option.id === hostValue) ?? readyHostOptions[0] ?? null
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
      if (!readyHostOptions.some((candidate) => candidate.id === setupId)) {
        return
      }
      onHostChange?.(setupId)
      onRecipeChange?.(null)
      setOpen(false)
    },
    [onHostChange, onRecipeChange, readyHostOptions]
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

  const connectHost = React.useCallback(
    async (option: NeedsSetupProjectHostOption): Promise<void> => {
      if (!option.connectAction || !onConnectHost || connectingHostIds.has(option.hostId)) {
        return
      }
      setConnectingHostIds((current) => new Set(current).add(option.hostId))
      try {
        await onConnectHost(option)
      } finally {
        // Why: always clear the in-flight id when the connect settles (success, failure, or
        // timeout) so the row's spinner stops. No mounted-guard — a stale setState on an
        // unmounted component is a harmless no-op in React 18, and the guard's ref was the
        // source of a StrictMode bug that left the spinner stuck.
        setConnectingHostIds((current) => {
          if (!current.has(option.hostId)) {
            return current
          }
          const next = new Set(current)
          next.delete(option.hostId)
          return next
        })
      }
    },
    [connectingHostIds, onConnectHost]
  )

  // Why: the submenu rows open their popover on hover/focus (not just click) to feel like a
  // menu; opening one closes the other so the two right-side popovers never stack.
  const openVmRecipesSubmenu = React.useCallback((): void => {
    setHostActionsOpen(false)
    setVmRecipesOpen(true)
  }, [])

  const openHostActionsSubmenu = React.useCallback((): void => {
    setVmRecipesOpen(false)
    setHostActionsOpen(true)
  }, [])

  // Why: hovering/highlighting a plain host row dismisses any submenu popover left open from
  // passing over the recipe/add-host rows, so a stray submenu can't linger over the list.
  const closeSubmenus = React.useCallback((): void => {
    setVmRecipesOpen(false)
    setHostActionsOpen(false)
  }, [])

  const handleAddSshHost = React.useCallback((): void => {
    setHostActionsOpen(false)
    setOpen(false)
    onAddSshHost?.()
  }, [onAddSshHost])

  const handleAddRemoteServer = React.useCallback((): void => {
    setHostActionsOpen(false)
    setOpen(false)
    onAddRemoteServer?.()
  }, [onAddRemoteServer])

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
              <HostRowIcon hostId={selectedHost.hostId} />
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
            {readyHostOptions.map((option) => (
              <CommandItem
                key={option.id}
                value={`host:${option.id}`}
                onSelect={() => handleHostSelect(option.id)}
                onPointerEnter={closeSubmenus}
                onFocus={closeSubmenus}
                className="items-center gap-2 px-3 py-1.5"
              >
                <Check
                  className={cn(
                    'size-4 text-foreground',
                    !selectedRecipe && option.id === selectedHost?.id ? 'opacity-100' : 'opacity-0'
                  )}
                />
                <HostRowIcon hostId={option.hostId} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm">{option.label}</div>
                  <HostPathTooltip path={option.path} />
                </div>
              </CommandItem>
            ))}
            {/* Why: not-connected hosts are dormant, not errors — a separator (no heading) sets
                them off as a secondary group without labeling the recipe/add-host rows below. */}
            {needsSetupHostOptions.length > 0 ? (
              <>
                <CommandSeparator />
                {needsSetupHostOptions.map((option) => (
                  // Why: setup-on-host is a follow-up; this row only explains why the host cannot
                  // run the workspace yet. It stays highlightable (no `disabled`) so it matches the
                  // hover of the other rows, but selecting it is a no-op since it isn't ready.
                  <CommandItem
                    key={option.id}
                    value={option.id}
                    onSelect={() => {}}
                    onPointerEnter={closeSubmenus}
                    onFocus={closeSubmenus}
                    className="items-center gap-2 px-3 py-1.5"
                  >
                    <div className="flex min-w-0 flex-1 items-center gap-2 opacity-60">
                      <Check className="size-4 opacity-0" />
                      {/* Why: show a spinner while connecting; otherwise reserve the alarm glyph for
                          a genuine connection error and give a dormant disconnected host the neutral
                          server icon. */}
                      {connectingHostIds.has(option.hostId) ? (
                        <LoaderCircle className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
                      ) : option.attention ? (
                        <AlertTriangle className="size-3.5 shrink-0 text-muted-foreground" />
                      ) : (
                        <HostRowIcon hostId={option.hostId} />
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm">{option.label}</div>
                        <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
                          {option.detail}
                        </div>
                      </div>
                    </div>
                    {option.connectAction && onConnectHost ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        className="ml-1 shrink-0 gap-1 text-muted-foreground/50 hover:text-muted-foreground"
                        // Why: only disable the row being connected — not every row — so one
                        // stuck/slow connect can't lock out connecting to the other hosts.
                        disabled={connectingHostIds.has(option.hostId)}
                        onPointerDown={(event) => {
                          event.preventDefault()
                          event.stopPropagation()
                        }}
                        onClick={(event) => {
                          event.preventDefault()
                          event.stopPropagation()
                          // Why: keep the picker open so the connecting state stays visible; the
                          // row updates in place from store SSH state once the connect resolves.
                          void connectHost(option)
                        }}
                      >
                        {connectingHostIds.has(option.hostId) ? (
                          <>
                            <LoaderCircle className="size-3 animate-spin" />
                            {translate(
                              'auto.components.NewWorkspaceComposerCard.connectingHost',
                              'Connecting…'
                            )}
                          </>
                        ) : (
                          translate(
                            'auto.components.NewWorkspaceComposerCard.connectHost',
                            'Connect'
                          )
                        )}
                      </Button>
                    ) : null}
                  </CommandItem>
                ))}
              </>
            ) : null}
            {/* Why: separate the host list from the per-workspace-env row; the "Add host" action
                is pinned below the list with its own border, so it needs no separator here. */}
            {recipes.length > 0 &&
            (readyHostOptions.length > 0 || needsSetupHostOptions.length > 0) ? (
              <CommandSeparator />
            ) : null}
            {recipes.length > 0 ? (
              <Popover open={vmRecipesOpen} onOpenChange={setVmRecipesOpen}>
                <PopoverTrigger asChild>
                  {/* Why: a real CommandItem (not a raw button) so cmdk registers it — fixes missing rows, uneven height, and double-highlight. */}
                  <CommandItem
                    value="per-workspace-env"
                    onSelect={openVmRecipesSubmenu}
                    onPointerEnter={openVmRecipesSubmenu}
                    onFocus={openVmRecipesSubmenu}
                    className="items-center gap-2 px-3 py-1.5"
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
                      {/* Why: a second line so this row matches the two-line host options above and hints what it opens. */}
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
                          className="items-center gap-2 px-3 py-1.5"
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
          {/* Why: pin "Add host" below the scrollable list — mirrors the Project combobox's
              "Add a new project" footer so it keeps a compact single-row height and one clean
              divider instead of a taller in-list row above the popover edge. */}
          <div className="border-t border-border">
            <Popover open={hostActionsOpen} onOpenChange={setHostActionsOpen}>
              {/* Why: an Anchor (not a Trigger) so click/hover/focus all just open the submenu —
                  a Trigger's own toggle would fight the hover-open and close it on the same click. */}
              <PopoverAnchor asChild>
                <Button
                  type="button"
                  variant="ghost"
                  data-run-target-add-host="true"
                  onClick={openHostActionsSubmenu}
                  onPointerEnter={openHostActionsSubmenu}
                  onFocus={openHostActionsSubmenu}
                  className="h-8 w-full justify-start gap-2 rounded-none px-3 text-xs font-normal"
                >
                  <Plus className="size-3.5 shrink-0 text-muted-foreground" />
                  <span>
                    {translate('auto.components.NewWorkspaceComposerCard.addHost', 'Add host')}
                  </span>
                  <ChevronRight className="ml-auto size-3.5 shrink-0 text-muted-foreground" />
                </Button>
              </PopoverAnchor>
              <PopoverContent side="right" align="start" sideOffset={6} className="w-72 p-0">
                {/* Why: pin an empty value so cmdk doesn't auto-highlight the first row on open —
                    matches the recipes submenu, which leaves nothing highlighted by default. */}
                <Command value="">
                  <CommandList>
                    <CommandItem
                      value="add-ssh-host"
                      onSelect={handleAddSshHost}
                      className="items-center gap-2 px-3 py-1.5"
                    >
                      <Server className="size-3.5 shrink-0 text-muted-foreground" />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm">
                          {translate(
                            'auto.components.NewWorkspaceComposerCard.addSshHost',
                            'Add SSH host'
                          )}
                        </div>
                        <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
                          {translate(
                            'auto.components.NewWorkspaceComposerCard.addSshHostHint',
                            'Use an existing machine over SSH'
                          )}
                        </div>
                      </div>
                    </CommandItem>
                    <CommandItem
                      value="add-remote-orca-server"
                      onSelect={handleAddRemoteServer}
                      className="items-center gap-2 px-3 py-1.5"
                    >
                      <Cloud className="size-3.5 shrink-0 text-muted-foreground" />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm">
                          {translate(
                            'auto.components.NewWorkspaceComposerCard.addRemoteOrcaServer',
                            'Add Remote Orca Server'
                          )}
                        </div>
                        <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
                          {translate(
                            'auto.components.NewWorkspaceComposerCard.addRemoteOrcaServerHint',
                            'Pair another Orca runtime'
                          )}
                        </div>
                      </div>
                    </CommandItem>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
          </div>
        </Command>
      </PopoverContent>
    </Popover>
  )
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
  sparseControlsEnabled = true,
  onAddProjectOverride
}: NewWorkspaceComposerCardProps): React.JSX.Element {
  // Why: subscribe (form uses translate() directly) so an open create dialog repaints when the UI language changes.
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
  const handleConnectRunTargetHost = React.useCallback(
    async (option: NeedsSetupProjectHostOption): Promise<void> => {
      const action = option.connectAction
      if (!action) {
        return
      }
      try {
        if (action.kind === 'ssh') {
          // Why: ssh.connect has no built-in timeout; a stalled connect would otherwise leave the
          // row's spinner/disabled state stuck forever. Bound the UI wait — the backend keeps
          // connecting and the picker updates from store SSH state if it later succeeds.
          await withUiConnectTimeout(window.api.ssh.connect({ targetId: action.targetId }))
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
            <div className="space-y-1">
              <label className="block min-w-0 truncate text-xs font-medium text-muted-foreground">
                {translate('auto.components.NewWorkspaceComposerCard.runOn', 'Run on')}
              </label>
              <WorkspaceRunTargetCombobox
                hostOptions={projectHostSetupOptions}
                hostValue={selectedProjectHostSetupId ?? null}
                onHostChange={handleProjectHostSetupChange}
                recipes={ephemeralVmRecipes}
                recipeValue={selectedEphemeralVmRecipeId}
                onRecipeChange={onEphemeralVmRecipeChange}
                onAddSshHost={handleAddSshHost}
                onAddRemoteServer={handleAddRemoteServer}
                onConnectHost={handleConnectRunTargetHost}
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
            triggerClassName="h-9 w-full border-input text-sm focus:border-ring focus:ring-[3px] focus:ring-ring/50"
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
                  onInput={(event) => {
                    // Why: reset then size to content so short notes stay compact and long ones grow without a scrollbar until max-h clamps.
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
      {/* Why: layer the host-add form over the composer instead of navigating to Settings so
          the in-progress workspace form is preserved; on success the new host flows back into
          the run-target picker via the store. */}
      <AddRemoteHostDialog mode={addRemoteHostMode} onOpenChange={setAddRemoteHostMode} />
    </div>
  )
}
