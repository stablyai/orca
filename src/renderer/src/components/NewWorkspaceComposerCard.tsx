/* eslint-disable max-lines -- Why: this component intentionally keeps the full
composer card markup together so the inline and modal variants share one UI
surface without splitting the controlled form into hard-to-follow fragments. */
import React from 'react'
import {
  Check,
  ChevronDown,
  CornerDownLeft,
  FolderPlus,
  LoaderCircle,
  Settings2
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import RepoCombobox from '@/components/repo/RepoCombobox'
import AgentCombobox from '@/components/agent/AgentCombobox'
import { AGENT_CATALOG } from '@/lib/agent-catalog'
import { useAppStore } from '@/store'
import { cn } from '@/lib/utils'
import type {
  GitHubWorkItem,
  GitLabWorkItem,
  LinearIssue,
  SparsePreset,
  TuiAgent
} from '../../../shared/types'
import SparseCheckoutPresetSelect from '@/components/sparse/SparseCheckoutPresetSelect'
import SmartWorkspaceNameField, {
  type SmartWorkspaceNameSelection
} from '@/components/new-workspace/SmartWorkspaceNameField'
import type { WorkspaceCreateErrorDisplay } from '@/lib/workspace-create-error-format'

const isMac = typeof navigator !== 'undefined' && navigator.userAgent.includes('Mac')

type RepoOption = React.ComponentProps<typeof RepoCombobox>['repos'][number]

type NewWorkspaceComposerCardProps = {
  containerClassName?: string
  composerRef?: React.RefObject<HTMLDivElement | null>
  nameInputRef?: React.RefObject<HTMLInputElement | null>
  quickAgent: TuiAgent | null
  onQuickAgentChange: (agent: TuiAgent | null) => void
  eligibleRepos: RepoOption[]
  repoId: string
  onRepoChange: (value: string) => void
  name: string
  onNameValueChange: (value: string) => void
  onSmartGitHubItemSelect: (item: GitHubWorkItem) => void
  onSmartGitLabItemSelect: (item: GitLabWorkItem) => void
  onSmartBranchSelect: (refName: string) => void
  onSmartLinearIssueSelect: (issue: LinearIssue) => void
  smartNameSelection: SmartWorkspaceNameSelection | null
  onClearSmartNameSelection: () => void
  detectedAgentIds: Set<TuiAgent> | null
  onOpenAgentSettings: () => void
  advancedOpen: boolean
  onToggleAdvanced: () => void
  createDisabled: boolean
  creating: boolean
  onCreate: () => void
  note: string
  onNoteChange: (value: string) => void
  setupConfig: { source: 'yaml' | 'legacy'; command: string } | null
  requiresExplicitSetupChoice: boolean
  setupDecision: 'run' | 'skip' | null
  onSetupDecisionChange: (value: 'run' | 'skip') => void
  shouldWaitForSetupCheck: boolean
  resolvedSetupDecision: 'run' | 'skip' | null
  createError: WorkspaceCreateErrorDisplay | null
  canUseSparseCheckout: boolean
  sparsePresets: SparsePreset[]
  sparseSelectedPresetId: string | null
  onSparseSelectPreset: (preset: SparsePreset | null) => void
}

function SetupCommandPreview({
  setupConfig,
  headerAction
}: {
  setupConfig: { source: 'yaml' | 'legacy'; command: string }
  headerAction?: React.ReactNode
}): React.JSX.Element {
  if (setupConfig.source === 'yaml') {
    return (
      <div className="rounded-2xl border border-border/60 bg-muted/40 shadow-inner">
        <div className="flex items-center justify-between gap-3 border-b border-border/60 px-4 py-2.5">
          <div className="font-mono text-[11px] text-muted-foreground">orca.yaml</div>
          {headerAction}
        </div>
        <pre className="overflow-x-auto whitespace-pre-wrap break-words px-4 py-3 font-mono text-[12px] leading-5 text-emerald-700 dark:text-emerald-300/95">
          {setupConfig.command}
        </pre>
      </div>
    )
  }

  return (
    <div className="rounded-2xl border border-border/60 bg-muted/35 px-4 py-3 shadow-inner">
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
          Legacy setup command
        </div>
        {headerAction}
      </div>
      <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-[12px] leading-5 text-foreground">
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
    // internal in-app drags (text/x-orca-file-path) must not trigger the
    // attachment-drop highlight so they still route to their own handlers.
    if (!event.dataTransfer.types.includes('Files')) {
      return
    }
    if (event.dataTransfer.types.includes('text/x-orca-file-path')) {
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
      // carry both 'Files' and 'text/x-orca-file-path' types) don't decrement
      // the counter when enter skipped incrementing it — otherwise the counter
      // goes negative and the native-drag highlight state desyncs.
      if (event.dataTransfer.types.includes('text/x-orca-file-path')) {
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
  containerClassName,
  composerRef,
  nameInputRef,
  quickAgent,
  onQuickAgentChange,
  eligibleRepos,
  repoId,
  onRepoChange,
  name,
  onNameValueChange,
  onSmartGitHubItemSelect,
  onSmartGitLabItemSelect,
  onSmartBranchSelect,
  onSmartLinearIssueSelect,
  smartNameSelection,
  onClearSmartNameSelection,
  detectedAgentIds,
  onOpenAgentSettings,
  advancedOpen,
  onToggleAdvanced,
  createDisabled,
  creating,
  onCreate,
  note,
  onNoteChange,
  setupConfig,
  requiresExplicitSetupChoice,
  setupDecision,
  onSetupDecisionChange,
  shouldWaitForSetupCheck,
  resolvedSetupDecision,
  createError,
  canUseSparseCheckout,
  sparsePresets,
  sparseSelectedPresetId,
  onSparseSelectPreset
}: NewWorkspaceComposerCardProps): React.JSX.Element {
  const { isFileDragOver, dragHandlers } = useComposerFileDragOver()
  const openModal = useAppStore((s) => s.openModal)
  const defaultTuiAgent = useAppStore((s) => s.settings?.defaultTuiAgent ?? null)
  const updateSettings = useAppStore((s) => s.updateSettings)

  const handleSetDefaultAgent = React.useCallback(
    (next: TuiAgent | 'blank' | null) => {
      updateSettings({ defaultTuiAgent: next })
    },
    [updateSettings]
  )

  const focusNameInput = React.useCallback(() => {
    // Why: after the repo picker commits a choice, moving focus to the name
    // field keeps the keyboard flow progressing through the form instead of
    // trapping the user in the repo popover interaction.
    requestAnimationFrame(() => {
      nameInputRef?.current?.focus()
    })
  }, [nameInputRef])

  const visibleQuickAgents = React.useMemo(
    () =>
      AGENT_CATALOG.filter((agent) => detectedAgentIds === null || detectedAgentIds.has(agent.id)),
    [detectedAgentIds]
  )

  const handleAddRepo = React.useCallback((): void => {
    openModal('add-repo')
  }, [openModal])

  return (
    <div
      ref={composerRef}
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
        <div className="space-y-1">
          <div className="flex items-center justify-between gap-2">
            <label className="text-xs font-medium text-muted-foreground">Repository</label>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  onClick={handleAddRepo}
                  className="size-5 shrink-0 rounded-sm text-muted-foreground hover:text-foreground"
                  aria-label="Add folder or repository"
                >
                  <FolderPlus className="size-3" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={6}>
                Add project
              </TooltipContent>
            </Tooltip>
          </div>
          <RepoCombobox
            repos={eligibleRepos}
            value={repoId}
            onValueChange={onRepoChange}
            onValueSelected={focusNameInput}
            placeholder="Choose repository"
            // Why: programmatic .focus() from the Dialog's onOpenAutoFocus
            // handler does not reliably trigger :focus-visible in Chromium.
            // Mirror the Input component's standard ring (border-ring +
            // ring-ring/50, 3px) onto :focus so the autofocused repo trigger
            // paints the familiar field ring instead of leaving no visible
            // focus state.
            triggerClassName="h-9 w-full border-input text-sm focus:border-ring focus:ring-[3px] focus:ring-ring/50"
            showStandaloneAddButton={false}
          />
        </div>

        <div className="min-w-0 space-y-1">
          <label className="text-xs font-medium text-muted-foreground">
            Name or &apos;Create From&apos;{' '}
            <span className="text-muted-foreground/70">[Optional]</span>
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
        </div>

        <div className="space-y-1">
          <div className="flex items-center justify-between gap-2">
            <label className="text-xs font-medium text-muted-foreground">Agent</label>
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
                  aria-label="Open agent settings"
                >
                  <Settings2 className="size-3" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={6}>
                Configure agents
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

        <div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onToggleAdvanced}
            className="-ml-2 text-xs"
          >
            Advanced
            <ChevronDown
              className={cn('size-4 transition-transform', advancedOpen && 'rotate-180')}
            />
          </Button>
        </div>

        <div
          className={cn(
            'grid overflow-hidden transition-[grid-template-rows] duration-200 ease-out',
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
                // Why: when a source (PR/issue/Linear/branch) is picked the
                // smart field shows a pill instead of an editable name, so
                // surface the auto-derived workspace name here under Advanced
                // where it can be reviewed/overridden. When the user typed an
                // explicit name there's no source pill — the smart input is
                // already the name field, so we don't duplicate it here.
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground">Name</label>
                  <input
                    type="text"
                    value={name}
                    onChange={(event) => onNameValueChange(event.target.value)}
                    placeholder="Workspace name"
                    className="w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-1.5 text-sm shadow-xs transition-[color,box-shadow] outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
                  />
                </div>
              ) : null}

              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground">Note</label>
                <textarea
                  value={note}
                  onChange={(event) => onNoteChange(event.target.value)}
                  onInput={(event) => {
                    // Why: start at one-line height, grow to fit content so a short
                    // note keeps the dialog compact while longer notes get room to
                    // breathe without a scroll bar until the max-h clamps growth.
                    const ta = event.currentTarget
                    ta.style.height = 'auto'
                    ta.style.height = `${ta.scrollHeight}px`
                  }}
                  placeholder="Write a note"
                  rows={1}
                  className="w-full min-w-0 resize-none overflow-hidden rounded-md border border-input bg-transparent px-3 py-1.5 text-sm shadow-xs transition-[color,box-shadow] outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 max-h-40"
                />
              </div>

              {setupConfig ? (
                <div className="space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <label className="text-xs font-medium text-muted-foreground">
                      Setup script
                    </label>
                    <span className="rounded-full border border-border/70 bg-muted/45 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.14em] text-foreground/70">
                      {setupConfig.source === 'yaml' ? 'orca.yaml' : 'legacy hooks'}
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
                          <span>Run setup command</span>
                        </label>
                      )
                    }
                  />

                  {requiresExplicitSetupChoice ? (
                    <div className="space-y-2">
                      <div className="text-[11px] font-medium text-muted-foreground">
                        Run setup now?
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <Button
                          type="button"
                          onClick={() => onSetupDecisionChange('run')}
                          variant={setupDecision === 'run' ? 'default' : 'outline'}
                          size="sm"
                        >
                          Run setup now
                        </Button>
                        <Button
                          type="button"
                          onClick={() => onSetupDecisionChange('skip')}
                          variant={setupDecision === 'skip' ? 'secondary' : 'outline'}
                          size="sm"
                        >
                          Skip for now
                        </Button>
                      </div>
                      {!setupDecision ? (
                        <div className="text-xs text-muted-foreground">
                          {shouldWaitForSetupCheck
                            ? 'Checking setup configuration...'
                            : 'Choose whether to run setup before creating this workspace.'}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              ) : null}

              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">Sparse checkout</label>
                <SparseCheckoutPresetSelect
                  repoId={repoId}
                  presets={sparsePresets}
                  selectedPresetId={sparseSelectedPresetId}
                  onSelectPreset={onSparseSelectPreset}
                  disabled={!canUseSparseCheckout}
                />
                {!canUseSparseCheckout ? (
                  <p className="text-[11px] text-muted-foreground">
                    Only available for local repositories.
                  </p>
                ) : null}
              </div>
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

      <div className="flex justify-end">
        <Button
          onClick={() => void onCreate()}
          disabled={createDisabled}
          size="sm"
          className="text-xs"
        >
          {creating ? <LoaderCircle className="size-4 animate-spin" /> : null}
          Create Workspace
          <span className="ml-1 inline-flex items-center gap-0.5 rounded border border-white/20 px-1.5 py-0.5 text-[10px] font-medium leading-none text-current/80">
            <span>{isMac ? '⌘' : 'Ctrl'}</span>
            <CornerDownLeft className="size-3" />
          </span>
        </Button>
      </div>
    </div>
  )
}
