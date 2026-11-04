import { ImeInput } from '@/lib/ime-text-field'
import React, { useCallback, useMemo, useState } from 'react'
import { ChevronDown, FolderPlus } from 'lucide-react'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { NewWorkspaceProjectOption } from '@/lib/new-workspace-project-options'
import { translate } from '@/i18n/i18n'
import {
  getAmbiguousProjectOptionIds,
  rankProjectOptions,
  sectionProjectOptions
} from './project-combobox-matching'
import { ProjectOptionMark, ProjectOptionRow } from './ProjectComboboxRow'
import { useRecentProjectIds } from './use-recent-project-ids'
import { isWithinComboboxRoot, useTypeAheadCombobox } from './use-type-ahead-combobox'
import { COMBOBOX_FIELD_SHELL, COMBOBOX_POPOVER_SURFACE } from './type-ahead-combobox-styles'

type ProjectComboboxProps = {
  options: readonly NewWorkspaceProjectOption[]
  value: string | null
  onValueChange: (projectId: string) => void
  onValueSelected?: (projectId: string) => void
  onAddProject?: () => void
  placeholder?: string
  triggerClassName?: string
  invalid?: boolean
  describedBy?: string
}

const ADD_PROJECT_KEY = 'add-project'
const ROOT_ATTRIBUTE = 'data-project-combobox-root'

/** Use one search field and one shared pointer/keyboard cursor; pin Add project so empty/long lists keep it reachable. */
export default function ProjectCombobox({
  options,
  value,
  onValueChange,
  onValueSelected,
  onAddProject,
  placeholder = 'Choose project',
  triggerClassName,
  invalid = false,
  describedBy
}: ProjectComboboxProps): React.JSX.Element {
  const [tooltipOpen, setTooltipOpen] = useState(false)
  const recentIds = useRecentProjectIds()
  // Derive keys from the displayed sections: folder grouping changes raw rank order, so keyboard selection must follow what users see.
  const deriveRowKeys = useCallback(
    (query: string): string[] => [
      ...sectionProjectOptions(
        rankProjectOptions(options, query, recentIds),
        query,
        recentIds
      ).flatMap((section) => section.items.map((match) => match.option.id)),
      ...(onAddProject ? [ADD_PROJECT_KEY] : [])
    ],
    [onAddProject, options, recentIds]
  )
  const {
    query,
    setQuery,
    open,
    setOpen,
    close,
    handleOpenChange,
    armedKey,
    arm,
    moveArm,
    inputRef,
    listId,
    setListNode
  } = useTypeAheadCombobox(deriveRowKeys)

  const matches = useMemo(
    () => rankProjectOptions(options, query, recentIds),
    [options, query, recentIds]
  )
  const sections = useMemo(
    () => sectionProjectOptions(matches, query, recentIds),
    [matches, query, recentIds]
  )
  const ambiguous = useMemo(() => getAmbiguousProjectOptionIds(options), [options])
  const selected = options.find((option) => option.id === value) ?? null
  const committed = selected !== null && query.length === 0

  const commit = useCallback(
    (key: string | null): void => {
      if (key === null) {
        return
      }
      close()
      if (key === ADD_PROJECT_KEY) {
        onAddProject?.()
        return
      }
      onValueChange(key)
      onValueSelected?.(key)
    },
    [close, onAddProject, onValueChange, onValueSelected]
  )

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>): void => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        setOpen(true)
        moveArm(event.key === 'ArrowDown' ? 1 : -1)
        return
      }
      if (event.key === 'Enter' && open) {
        event.preventDefault()
        commit(armedKey)
        return
      }
      // Handle Escape even while closed to clear stranded queries; bubble only when there is no committed display to restore.
      if (event.key === 'Escape' && (open || query.length > 0)) {
        event.preventDefault()
        event.stopPropagation()
        close()
        return
      }
      if (event.key === 'Backspace' && committed && selected) {
        event.preventDefault()
        setQuery(selected.displayName)
        setOpen(true)
      }
    },
    [armedKey, close, commit, committed, moveArm, open, query, selected, setOpen, setQuery]
  )

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <Tooltip open={tooltipOpen && committed && !open} onOpenChange={setTooltipOpen}>
        <PopoverAnchor asChild>
          <TooltipTrigger asChild>
            <div
              data-project-combobox-root="true"
              onClick={() => {
                inputRef.current?.focus()
                setOpen(true)
              }}
              className={cn(
                COMBOBOX_FIELD_SHELL,
                invalid && 'border-destructive ring-destructive/20 dark:ring-destructive/40',
                triggerClassName
              )}
            >
              <span className="flex w-4 shrink-0 items-center justify-center">
                {committed && selected ? <ProjectOptionMark option={selected} /> : null}
              </span>
              <div className="relative min-w-0 flex-1 overflow-hidden">
                <ImeInput
                  ref={inputRef}
                  type="text"
                  role="combobox"
                  data-project-combobox-root="true"
                  aria-label={translate(
                    'auto.components.new.workspace.ProjectCombobox.label',
                    'Project'
                  )}
                  aria-expanded={open}
                  aria-controls={listId}
                  aria-autocomplete="list"
                  aria-activedescendant={open && armedKey ? `${listId}-armed` : undefined}
                  aria-invalid={invalid ? true : undefined}
                  aria-describedby={describedBy}
                  value={query}
                  placeholder={committed ? '' : placeholder}
                  onChange={(event) => {
                    setQuery(event.target.value)
                    setOpen(true)
                  }}
                  onFocus={() => setOpen(true)}
                  onKeyDown={handleKeyDown}
                  className={cn(
                    'w-full min-w-0 bg-transparent text-sm outline-none placeholder:text-muted-foreground',
                    committed && 'text-transparent caret-foreground'
                  )}
                />
                {committed && selected ? (
                  <div
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-0 flex min-w-0 items-center text-sm"
                  >
                    <span className="truncate">{selected.displayName}</span>
                  </div>
                ) : null}
              </div>
              <button
                type="button"
                tabIndex={-1}
                aria-label={translate(
                  'auto.components.new.workspace.ProjectCombobox.browse',
                  'Browse projects'
                )}
                onMouseDown={(event) => event.preventDefault()}
                onClick={(event) => {
                  event.stopPropagation()
                  inputRef.current?.focus()
                  setOpen(!open)
                }}
                className="-mr-1 flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <ChevronDown
                  className={cn('size-3.5 transition-transform', open && 'rotate-180')}
                />
              </button>
            </div>
          </TooltipTrigger>
        </PopoverAnchor>
        {committed && selected ? (
          <TooltipContent side="top" sideOffset={4} className="max-w-96 break-all">
            <div className="font-medium">{selected.displayName}</div>
            <div>{selected.detail}</div>
          </TooltipContent>
        ) : null}
      </Tooltip>
      {/* Closing must remove the selector before a nested dialog takes focus. */}
      {open ? (
        <PopoverContent
          align="start"
          sideOffset={4}
          // Use an opaque nonfading surface so dialog fields cannot show through during animation; match the primitive’s arbitrary background specificity.
          className={cn(
            'flex w-[var(--radix-popover-trigger-width)] min-w-[17rem] flex-col p-0',
            COMBOBOX_POPOVER_SURFACE
          )}
          // Keep focus in the search anchor; automatic open/close focus would move it away.
          onOpenAutoFocus={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => event.preventDefault()}
          // The search anchor sits outside Radix content; preserve interactions inside this control instead of dismissing them as outside events.
          onFocusOutside={(event) => {
            if (isWithinComboboxRoot(event.target, ROOT_ATTRIBUTE)) {
              event.preventDefault()
            }
          }}
          onInteractOutside={(event) => {
            if (isWithinComboboxRoot(event.target, ROOT_ATTRIBUTE)) {
              event.preventDefault()
            }
          }}
        >
          {/* Keep scrolling options and pinned Add under the same listbox. */}
          <div
            id={listId}
            role="listbox"
            aria-label={translate(
              'auto.components.new.workspace.ProjectCombobox.listLabel',
              'Projects'
            )}
            className="flex min-h-0 flex-col"
          >
            {/* Presentation preserves listbox ownership through this scrolling wrapper. */}
            <div
              ref={setListNode}
              role="presentation"
              className="max-h-72 min-h-0 flex-1 overflow-y-auto p-1 scrollbar-sleek"
            >
              {matches.length === 0 ? (
                // Match row height so empty results stay visually neutral.
                <p className="flex h-8 items-center justify-center px-2 text-sm text-muted-foreground">
                  {options.length === 0
                    ? translate(
                        'auto.components.new.workspace.ProjectCombobox.noProjects',
                        'No projects yet.'
                      )
                    : translate(
                        'auto.components.new.workspace.ProjectCombobox.empty',
                        'No projects match your search.'
                      )}
                </p>
              ) : null}
              {sections.map((section) => (
                // Group role preserves accessible ownership and makes section headings announceable.
                <div key={section.key} role="group" aria-label={section.heading ?? undefined}>
                  {section.heading ? (
                    <div
                      aria-hidden="true"
                      className="px-2 pt-2.5 pb-1 text-[11px] font-semibold tracking-[0.05em] text-muted-foreground uppercase"
                    >
                      {section.heading}
                    </div>
                  ) : null}
                  {section.items.map((scored) => (
                    <ProjectOptionRow
                      key={scored.option.id}
                      option={scored.option}
                      nameHits={scored.nameHits}
                      detailHits={scored.detailHits}
                      armed={armedKey === scored.option.id}
                      current={scored.option.id === value}
                      ambiguous={ambiguous.has(scored.option.id)}
                      optionId={armedKey === scored.option.id ? `${listId}-armed` : undefined}
                      onArm={() => arm(scored.option.id)}
                      onCommit={() => commit(scored.option.id)}
                    />
                  ))}
                </div>
              ))}
            </div>
            {onAddProject ? (
              <div
                role="option"
                id={armedKey === ADD_PROJECT_KEY ? `${listId}-armed` : undefined}
                aria-selected={armedKey === ADD_PROJECT_KEY}
                data-armed={armedKey === ADD_PROJECT_KEY || undefined}
                onMouseDown={(event) => event.preventDefault()}
                onMouseMove={() => arm(ADD_PROJECT_KEY)}
                onClick={() => commit(ADD_PROJECT_KEY)}
                className={cn(
                  'flex h-9 shrink-0 cursor-default items-center gap-2 border-t border-border px-3 text-sm',
                  armedKey === ADD_PROJECT_KEY && 'bg-accent text-accent-foreground'
                )}
              >
                <span className="flex w-4 shrink-0 items-center justify-center">
                  <FolderPlus className="size-3.5 text-muted-foreground" />
                </span>
                <span className="truncate">
                  {translate(
                    'auto.components.new.workspace.ProjectCombobox.addProject',
                    'Add project'
                  )}
                </span>
              </div>
            ) : null}
          </div>
        </PopoverContent>
      ) : null}
    </Popover>
  )
}
