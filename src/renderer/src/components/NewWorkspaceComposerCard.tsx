/* eslint-disable max-lines -- Why: this component intentionally keeps the full
composer card markup together so the inline and modal variants share one UI
surface without splitting the controlled form into hard-to-follow fragments. */
import React from 'react'
import {
  Check,
  ChevronDown,
  CircleDot,
  CornerDownLeft,
  GitPullRequest,
  Github,
  LoaderCircle,
  Paperclip,
  Plus,
  X
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuShortcut,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import RepoCombobox from '@/components/repo/RepoCombobox'
import { AGENT_CATALOG, AgentIcon } from '@/lib/agent-catalog'
import { cn } from '@/lib/utils'
import type { GitHubWorkItem, TuiAgent } from '../../../shared/types'

type RepoOption = React.ComponentProps<typeof RepoCombobox>['repos'][number]

type LinkedWorkItemSummary = {
  type: 'issue' | 'pr'
  number: number
  title: string
  url: string
} | null

type NewWorkspaceComposerCardProps = {
  containerClassName?: string
  composerRef?: React.RefObject<HTMLDivElement | null>
  nameInputRef?: React.RefObject<HTMLInputElement | null>
  promptTextareaRef?: React.RefObject<HTMLTextAreaElement | null>
  eligibleRepos: RepoOption[]
  repoId: string
  onRepoChange: (value: string) => void
  name: string
  onNameChange: (event: React.ChangeEvent<HTMLInputElement>) => void
  agentPrompt: string
  onAgentPromptChange: (value: string) => void
  onPromptKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void
  linkedOnlyTemplatePreview: string | null
  attachmentPaths: string[]
  getAttachmentLabel: (pathValue: string) => string
  onAddAttachment: () => void
  onRemoveAttachment: (pathValue: string) => void
  addAttachmentShortcut: string
  linkedWorkItem: LinkedWorkItemSummary
  onRemoveLinkedWorkItem: () => void
  linkPopoverOpen: boolean
  onLinkPopoverOpenChange: (open: boolean) => void
  linkQuery: string
  onLinkQueryChange: (value: string) => void
  filteredLinkItems: GitHubWorkItem[]
  linkItemsLoading: boolean
  linkDirectLoading: boolean
  normalizedLinkQuery: {
    query: string
    repoMismatch: string | null
  }
  onSelectLinkedItem: (item: GitHubWorkItem) => void
  tuiAgent: TuiAgent
  onTuiAgentChange: (value: TuiAgent) => void
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
  createError: string | null
}

function PromptPrefixTextarea({
  textareaRef,
  value,
  onChange,
  onKeyDown,
  placeholder,
  placeholderTone
}: {
  textareaRef?: React.RefObject<HTMLTextAreaElement | null>
  value: string
  onChange: (value: string) => void
  onKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void
  placeholder: string
  placeholderTone: 'muted' | 'ghost-prompt'
}): React.JSX.Element {
  const internalRef = React.useRef<HTMLTextAreaElement | null>(null)

  const setRefs = React.useCallback(
    (node: HTMLTextAreaElement | null) => {
      internalRef.current = node
      if (textareaRef) {
        textareaRef.current = node
      }
    },
    [textareaRef]
  )

  // Why: auto-size the textarea to its content and hoist scrolling onto the
  // outer wrapper. Any JS-driven overlay sync (listening to `scroll`, updating
  // `translateY`) always paints a frame behind the textarea's own scroll — on
  // momentum scroll that shows up as visible wobble between the `>` and the
  // typed text. Putting both elements inside the same native scroll container
  // makes them move in lockstep with zero JS and no cross-layer paint delay.
  React.useLayoutEffect(() => {
    const el = internalRef.current
    if (!el) {
      return
    }
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [value])

  return (
    // Why: allow the composer to grow with the user's prompt up to ~20 rows
    // (560px at leading-7 ≈ 28px/row) before scrolling. The inner textarea's
    // JS-driven auto-resize sets its own height to scrollHeight, so the wrapper
    // simply follows until the max-height cap engages and hands off to scroll.
    <div className="scrollbar-sleek max-h-[560px] overflow-auto">
      <div className="relative">
        <span
          aria-hidden
          className="pointer-events-none absolute left-4 top-4 select-none text-[15px] leading-7 font-semibold text-foreground"
        >
          {'>'}
        </span>
        <textarea
          ref={setRefs}
          // Why: native autoFocus reliably focuses the prompt on initial mount
          // — used by both the full-page composer and the Cmd+J modal so the
          // user can start typing immediately without an extra tab. Running
          // during React's mount means it beats Radix Dialog's FocusScope,
          // which would otherwise land focus on the first focusable child
          // (the "Workspace name" input that renders above this textarea).
          autoFocus
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          // Why: the "ghost-prompt" tone previews the exact issueCommand
          // template that will be sent to the agent when the user submits with
          // only a linked work item. Emphasising it with higher contrast makes
          // it obvious this is a real pending prompt, not instructional copy.
          className={cn(
            'block min-h-[110px] w-full resize-none overflow-hidden bg-transparent py-4 pl-4 pr-4 text-[15px] leading-7 text-foreground outline-none',
            placeholderTone === 'ghost-prompt'
              ? 'placeholder:text-foreground/70'
              : 'placeholder:text-muted-foreground/50'
          )}
          style={{ textIndent: '2ch' }}
          spellCheck={false}
        />
      </div>
    </div>
  )
}

function LinearIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={className} fill="currentColor">
      <path d="M2.886 4.18A11.982 11.982 0 0 1 11.99 0C18.624 0 24 5.376 24 12.009c0 3.64-1.62 6.903-4.18 9.105L2.887 4.18ZM1.817 5.626l16.556 16.556c-.524.33-1.075.62-1.65.866L.951 7.277c.247-.575.537-1.126.866-1.65ZM.322 9.163l14.515 14.515c-.71.172-1.443.282-2.195.322L0 11.358a12 12 0 0 1 .322-2.195Zm-.17 4.862 9.823 9.824a12.02 12.02 0 0 1-9.824-9.824Z" />
    </svg>
  )
}

function renderSetupYamlPreview(command: string): React.JSX.Element[] {
  const lines = ['scripts:', '  setup: |', ...command.split('\n').map((line) => `    ${line}`)]

  return lines.map((line, index) => {
    const keyMatch = line.match(/^(\s*)([a-zA-Z][\w-]*)(:\s*)(\|)?$/)
    if (keyMatch) {
      return (
        <div key={`${line}-${index}`} className="whitespace-pre">
          <span className="text-muted-foreground">{keyMatch[1]}</span>
          <span className="font-semibold text-sky-600 dark:text-sky-300">{keyMatch[2]}</span>
          <span className="text-muted-foreground">{keyMatch[3]}</span>
          {keyMatch[4] ? (
            <span className="text-amber-600 dark:text-amber-300">{keyMatch[4]}</span>
          ) : null}
        </div>
      )
    }

    return (
      <div key={`${line}-${index}`} className="whitespace-pre">
        <span className="text-emerald-700 dark:text-emerald-300/95">{line}</span>
      </div>
    )
  })
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
          <div className="text-[11px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
            orca.yaml
          </div>
          {headerAction}
        </div>
        <pre className="overflow-x-auto px-4 py-4 font-mono text-[12px] leading-6 text-foreground">
          {renderSetupYamlPreview(setupConfig.command)}
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
  promptTextareaRef,
  eligibleRepos,
  repoId,
  onRepoChange,
  name,
  onNameChange,
  agentPrompt,
  onAgentPromptChange,
  onPromptKeyDown,
  linkedOnlyTemplatePreview,
  attachmentPaths,
  getAttachmentLabel,
  onAddAttachment,
  onRemoveAttachment,
  addAttachmentShortcut,
  linkedWorkItem,
  onRemoveLinkedWorkItem,
  linkPopoverOpen,
  onLinkPopoverOpenChange,
  linkQuery,
  onLinkQueryChange,
  filteredLinkItems,
  linkItemsLoading,
  linkDirectLoading,
  normalizedLinkQuery,
  onSelectLinkedItem,
  tuiAgent,
  onTuiAgentChange,
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
  createError
}: NewWorkspaceComposerCardProps): React.JSX.Element {
  const { isFileDragOver, dragHandlers } = useComposerFileDragOver()
  return (
    <div className="grid gap-3">
      <div
        ref={composerRef}
        // Why: preload classifies native OS file drops by the nearest
        // `data-native-file-drop-target` marker in the composedPath. Tagging
        // the composer root makes drops anywhere on the card (modal or full
        // page) route to the composer attachment handler instead of falling
        // back to the default editor-open behavior.
        data-native-file-drop-target="composer"
        onDragEnter={dragHandlers.onDragEnter}
        onDragLeave={dragHandlers.onDragLeave}
        className={cn(
          'rounded-[20px] border border-border/50 bg-background/40 p-3 shadow-lg backdrop-blur-xl supports-[backdrop-filter]:bg-background/40 transition',
          isFileDragOver && 'border-ring ring-2 ring-ring/30',
          containerClassName
        )}
      >
        <div className="grid gap-3">
          <div className="flex items-center justify-between gap-3">
            <input
              ref={nameInputRef}
              type="text"
              value={name}
              onChange={onNameChange}
              placeholder="[Optional] Workspace name"
              className="h-9 min-w-0 flex-1 bg-transparent px-1 text-[14px] font-medium text-foreground outline-none placeholder:text-muted-foreground/80"
            />
            <div className="w-[240px] shrink-0">
              <RepoCombobox
                repos={eligibleRepos}
                value={repoId}
                onValueChange={onRepoChange}
                placeholder="Select a repository"
                triggerClassName="h-9 w-full rounded-[10px] border border-border/50 bg-background/50 px-3 text-sm font-medium shadow-sm transition hover:bg-muted/50 focus:ring-2 focus:ring-ring/20 focus:outline-none backdrop-blur-md supports-[backdrop-filter]:bg-background/50"
              />
            </div>
          </div>

          <div className="flex flex-col rounded-[16px] border border-border/60 bg-input/30 shadow-sm transition focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/20">
            {/* Why: the `>` is rendered as a visual overlay (aria-hidden) so
                it's never part of the submitted prompt value. It must behave
                like the first character of line 1 — inline with line 1's text
                and scrolling out of view with it. See PromptPrefixTextarea for
                how the shared-scroll-container approach avoids wobble. */}
            <PromptPrefixTextarea
              textareaRef={promptTextareaRef}
              value={agentPrompt}
              onChange={onAgentPromptChange}
              onKeyDown={onPromptKeyDown}
              placeholder={
                linkedOnlyTemplatePreview ?? 'Describe a task to start an agent, or leave blank...'
              }
              placeholderTone={linkedOnlyTemplatePreview ? 'ghost-prompt' : 'muted'}
            />

            {attachmentPaths.length > 0 || linkedWorkItem ? (
              <div className="flex flex-wrap gap-2 px-3">
                {linkedWorkItem ? (
                  <div className="inline-flex max-w-full items-center gap-2 rounded-full border border-border/50 bg-background/60 px-3 py-1 text-xs text-foreground transition hover:bg-muted/60 supports-[backdrop-filter]:bg-background/50">
                    {linkedWorkItem.type === 'pr' ? (
                      <GitPullRequest className="size-3.5 shrink-0" />
                    ) : (
                      <CircleDot className="size-3.5 shrink-0" />
                    )}
                    <span className="shrink-0 font-mono text-muted-foreground">
                      #{linkedWorkItem.number}
                    </span>
                    <span className="truncate" title={linkedWorkItem.url}>
                      {linkedWorkItem.title}
                    </span>
                    <button
                      type="button"
                      aria-label={`Remove linked ${linkedWorkItem.type} #${linkedWorkItem.number}`}
                      onClick={onRemoveLinkedWorkItem}
                      className="shrink-0 text-muted-foreground transition hover:text-foreground"
                    >
                      <X className="size-3.5" />
                    </button>
                  </div>
                ) : null}
                {attachmentPaths.map((pathValue) => (
                  <div
                    key={pathValue}
                    className="inline-flex max-w-full items-center gap-2 rounded-full border border-border/50 bg-background/60 px-3 py-1 text-xs text-foreground transition hover:bg-muted/60 supports-[backdrop-filter]:bg-background/50"
                  >
                    <Paperclip className="size-3.5 shrink-0" />
                    <span className="truncate" title={pathValue}>
                      {getAttachmentLabel(pathValue)}
                    </span>
                    <button
                      type="button"
                      aria-label={`Remove attachment ${getAttachmentLabel(pathValue)}`}
                      onClick={() => onRemoveAttachment(pathValue)}
                      className="shrink-0 text-muted-foreground transition hover:text-foreground"
                    >
                      <X className="size-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            ) : null}

            <div className="flex items-center justify-between px-3 pb-3 pt-2">
              <div className="flex items-center gap-1.5">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <div>
                      <DropdownMenu modal={false}>
                        <DropdownMenuTrigger asChild>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 rounded-full bg-transparent p-0 text-foreground hover:bg-muted/60 hover:text-foreground"
                            aria-label="Add attachment"
                          >
                            <Plus className="size-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="start">
                          <DropdownMenuItem onSelect={() => onAddAttachment()}>
                            <Paperclip className="size-4" />
                            Add attachment
                            <DropdownMenuShortcut>{addAttachmentShortcut}</DropdownMenuShortcut>
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </TooltipTrigger>
                  <TooltipContent side="top" sideOffset={6}>
                    Add files
                  </TooltipContent>
                </Tooltip>

                <Tooltip>
                  <TooltipTrigger asChild>
                    <div>
                      <Popover open={linkPopoverOpen} onOpenChange={onLinkPopoverOpenChange}>
                        <PopoverTrigger asChild>
                          <Button
                            type="button"
                            variant="ghost"
                            className="h-8 w-8 rounded-full bg-muted/55 p-0 text-foreground backdrop-blur-md hover:bg-muted/75 hover:text-foreground supports-[backdrop-filter]:bg-muted/50"
                            aria-label="Link GitHub issue or pull request"
                          >
                            <Github className="size-3.5" />
                          </Button>
                        </PopoverTrigger>
                        <PopoverContent align="start" className="w-80 p-0">
                          <Command shouldFilter={false}>
                            <CommandInput
                              autoFocus
                              placeholder="Search issues or pull requests..."
                              value={linkQuery}
                              onValueChange={onLinkQueryChange}
                            />
                            <CommandList className="max-h-[280px]">
                              {filteredLinkItems.length === 0 ? (
                                <CommandEmpty>
                                  {normalizedLinkQuery.repoMismatch
                                    ? `GitHub URL must match ${normalizedLinkQuery.repoMismatch}.`
                                    : linkItemsLoading || linkDirectLoading
                                      ? normalizedLinkQuery.query.trim()
                                        ? 'Searching...'
                                        : 'Loading...'
                                      : normalizedLinkQuery.query.trim()
                                        ? 'No issues or pull requests found.'
                                        : 'No recent issues or pull requests found.'}
                                </CommandEmpty>
                              ) : null}
                              {filteredLinkItems.length > 0 ? (
                                <CommandGroup
                                  heading={
                                    normalizedLinkQuery.query.trim()
                                      ? `${filteredLinkItems.length} result${filteredLinkItems.length === 1 ? '' : 's'}`
                                      : 'Recent issues & pull requests'
                                  }
                                >
                                  {filteredLinkItems.map((item) => (
                                    <CommandItem
                                      key={item.id}
                                      value={`${item.type}-${item.number}-${item.title}`}
                                      onSelect={() => onSelectLinkedItem(item)}
                                      className="group"
                                    >
                                      {item.type === 'pr' ? (
                                        <GitPullRequest className="size-3.5 shrink-0 text-muted-foreground" />
                                      ) : (
                                        <CircleDot className="size-3.5 shrink-0 text-muted-foreground" />
                                      )}
                                      <span className="shrink-0 font-mono text-xs text-muted-foreground">
                                        #{item.number}
                                      </span>
                                      <span className="min-w-0 flex-1 truncate text-xs">
                                        {item.title}
                                      </span>
                                      <Check className="size-3.5 shrink-0 opacity-0 group-data-[selected=true]:opacity-100" />
                                    </CommandItem>
                                  ))}
                                </CommandGroup>
                              ) : null}
                            </CommandList>
                          </Command>
                        </PopoverContent>
                      </Popover>
                    </div>
                  </TooltipTrigger>
                  <TooltipContent side="top" sideOffset={6}>
                    Add GH Issue / PR
                  </TooltipContent>
                </Tooltip>

                <Tooltip>
                  <TooltipTrigger asChild>
                    <span>
                      <Button
                        type="button"
                        variant="ghost"
                        disabled
                        className="h-8 w-8 rounded-full bg-muted/35 p-0 text-muted-foreground/70 backdrop-blur-md supports-[backdrop-filter]:bg-muted/30"
                        aria-label="Link Linear issue"
                      >
                        <LinearIcon className="size-3.5" />
                      </Button>
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="top" sideOffset={6}>
                    coming soon
                  </TooltipContent>
                </Tooltip>
              </div>

              <Select
                value={tuiAgent}
                onValueChange={(value) => onTuiAgentChange(value as TuiAgent)}
              >
                <SelectTrigger
                  size="sm"
                  className={cn(
                    'h-8 rounded-full border-border/50 bg-background/50 px-3 backdrop-blur-md supports-[backdrop-filter]:bg-background/50 transition-opacity',
                    !agentPrompt.trim() &&
                      !linkedOnlyTemplatePreview &&
                      'opacity-60 hover:opacity-100 grayscale-[0.5]'
                  )}
                >
                  <SelectValue>
                    <span className="flex items-center gap-2">
                      <AgentIcon agent={tuiAgent} />
                      <span>{AGENT_CATALOG.find((a) => a.id === tuiAgent)?.label ?? tuiAgent}</span>
                    </span>
                  </SelectValue>
                </SelectTrigger>
                <SelectContent align="end">
                  {AGENT_CATALOG.filter(
                    (a) => detectedAgentIds === null || detectedAgentIds.has(a.id)
                  ).map((option) => (
                    <SelectItem key={option.id} value={option.id}>
                      <span className="flex items-center gap-2">
                        <AgentIcon agent={option.id} />
                        <span>{option.label}</span>
                      </span>
                    </SelectItem>
                  ))}
                  <div className="border-t border-border/50 px-1 pb-0.5 pt-1">
                    <button
                      type="button"
                      className="flex w-full items-center gap-1.5 rounded-sm px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
                      onPointerDown={(event) => event.preventDefault()}
                      onClick={onOpenAgentSettings}
                    >
                      Manage agents
                      <svg
                        className="size-3"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                      >
                        <path d="M5 12h14M12 5l7 7-7 7" />
                      </svg>
                    </button>
                  </div>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="flex items-center justify-between">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="rounded-full px-2.5 text-muted-foreground hover:text-foreground"
              onClick={onToggleAdvanced}
            >
              Advanced
              <ChevronDown
                className={cn('size-4 transition-transform', advancedOpen && 'rotate-180')}
              />
            </Button>

            <div className="flex justify-end">
              <Button
                onClick={() => void onCreate()}
                disabled={createDisabled}
                size="sm"
                className="rounded-full px-3"
              >
                {creating ? <LoaderCircle className="size-4 animate-spin" /> : null}
                {agentPrompt.trim() || linkedOnlyTemplatePreview
                  ? 'Start Agent'
                  : 'Create Worktree'}
                <span className="ml-1 rounded-full border border-white/20 p-1 text-current/80">
                  <CornerDownLeft className="size-3" />
                </span>
              </Button>
            </div>
          </div>

          <div
            className={cn(
              'grid overflow-hidden transition-[grid-template-rows,opacity] duration-200 ease-out',
              advancedOpen ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
            )}
            aria-hidden={!advancedOpen}
          >
            <div className="min-h-0 px-3 pt-3">
              <div className="grid gap-5 pb-3">
                <div className="grid gap-1.5">
                  <label className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                    Note
                  </label>
                  <Input
                    value={note}
                    onChange={(event) => onNoteChange(event.target.value)}
                    placeholder="Write a note"
                    className="h-10 rounded-xl border-border/60 bg-input/30 shadow-sm"
                  />
                </div>

                {setupConfig ? (
                  <div className="grid gap-3">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <label className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                        Setup script
                      </label>
                      <span className="rounded-full border border-border/70 bg-muted/45 px-2.5 py-1 text-[10px] font-medium uppercase tracking-[0.16em] text-foreground/70 shadow-sm">
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
                      <div className="grid gap-2.5">
                        <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                          Run setup now?
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                          <button
                            type="button"
                            onClick={() => onSetupDecisionChange('run')}
                            className={cn(
                              'rounded-full border px-3.5 py-2 text-xs font-medium transition',
                              setupDecision === 'run'
                                ? 'border-emerald-500/40 bg-emerald-500/12 text-foreground shadow-sm'
                                : 'border-border/70 bg-muted/35 text-foreground/75 hover:text-foreground'
                            )}
                          >
                            Run setup now
                          </button>
                          <button
                            type="button"
                            onClick={() => onSetupDecisionChange('skip')}
                            className={cn(
                              'rounded-full border px-3.5 py-2 text-xs font-medium transition',
                              setupDecision === 'skip'
                                ? 'border-border/70 bg-foreground/10 text-foreground shadow-sm'
                                : 'border-border/70 bg-muted/35 text-foreground/75 hover:text-foreground'
                            )}
                          >
                            Skip for now
                          </button>
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
              </div>
            </div>
          </div>
        </div>
      </div>

      {createError ? (
        <div className="rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {createError}
        </div>
      ) : null}
    </div>
  )
}
