import { ImeInput } from '@/lib/text-input/ime/ime-text-field'
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, Github } from 'lucide-react'
import { isWithinAddProjectMenu } from '@/components/sidebar/project-admission/menu/AddProjectHostSubmenu'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { cn } from '@/lib/class-names'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import {
  getAmbiguousProjectOptionIds,
  rankProjectOptions,
  sectionProjectOptions
} from './project-combobox-matching'
import {
  ProjectComboboxAddProjectOption,
  type ProjectComboboxAddProjectMenu
} from './ProjectComboboxAddProjectOption'
import {
  handleProjectComboboxKeyDown,
  PROJECT_COMBOBOX_ADD_PROJECT_KEY
} from './project-combobox-keydown'
import { ProjectOptionMark, ProjectOptionRow } from './ProjectComboboxRow'
import { useRecentProjectIds } from './use-recent-project-ids'
import { isWithinComboboxRoot, useTypeAheadCombobox } from './use-type-ahead-combobox'
import type { ProjectComboboxProps } from './project-combobox-props'
import { COMBOBOX_FIELD_SHELL, COMBOBOX_POPOVER_SURFACE } from './type-ahead-combobox-styles'
import {
  cloudRepoKey,
  cloudRowKeys,
  commitCloudRow,
  filterCloudRepos,
  ProjectComboboxCloudSection,
  useOpenOnSignal
} from './ProjectComboboxCloudSection'

export type { ProjectComboboxAddProjectMenu }

const ADD_PROJECT_KEY = PROJECT_COMBOBOX_ADD_PROJECT_KEY
const ROOT_ATTRIBUTE = 'data-project-combobox-root'

/** Use one search field and one shared pointer/keyboard cursor; pin Add project so empty/long lists keep it reachable. */
export default function ProjectCombobox({
  options,
  value,
  onValueChange,
  onValueSelected,
  onAddProject,
  addProjectMenu,
  placeholder = 'Choose project',
  triggerClassName,
  invalid = false,
  describedBy,
  cloudRepos = null,
  cloudRepoValue = null,
  onCloudRepoSelected,
  onMoreCloudAccess,
  onShowMoreCloudRepos = null,
  openSignal = 0,
  focusSignal = 0
}: ProjectComboboxProps): React.JSX.Element {
  const t = useTranslate()
  const [tooltipOpen, setTooltipOpen] = useState(false)
  const quietFocus = useRef(false)
  const [cascadeOpen, setCascadeOpen] = useState(false)
  const [cascadeAutoFocus, setCascadeAutoFocus] = useState(false)
  const contentRef = useRef<HTMLDivElement>(null)
  const recentIds = useRecentProjectIds()
  const hasAddProjectRow = Boolean(onAddProject || addProjectMenu)
  // Derive keys from the displayed sections: folder grouping changes raw rank order, so keyboard selection must follow what users see.
  const deriveRowKeys = useCallback(
    (query: string): string[] => [
      ...sectionProjectOptions(
        rankProjectOptions(options, query, recentIds),
        query,
        recentIds
      ).flatMap((section) => section.items.map((match) => match.option.id)),
      ...cloudRowKeys(cloudRepos, query, onShowMoreCloudRepos, onMoreCloudAccess),
      ...(hasAddProjectRow ? [ADD_PROJECT_KEY] : [])
    ],
    [cloudRepos, hasAddProjectRow, onMoreCloudAccess, onShowMoreCloudRepos, options, recentIds]
  )
  const {
    query,
    setQuery,
    open,
    setOpen,
    close: closeCombobox,
    handleOpenChange: handleComboboxOpenChange,
    armedKey,
    arm,
    moveArm,
    inputRef,
    listId,
    setListNode
  } = useTypeAheadCombobox(
    deriveRowKeys,
    // Opening arms the committed project, matching the Run-on picker.
    value ?? null
  )

  const close = useCallback((): void => {
    setCascadeOpen(false)
    closeCombobox()
  }, [closeCombobox])

  const handleOpenChange = useCallback(
    (next: boolean): void => {
      if (!next) {
        setCascadeOpen(false)
      }
      handleComboboxOpenChange(next)
    },
    [handleComboboxOpenChange]
  )

  const matches = useMemo(
    () => rankProjectOptions(options, query, recentIds),
    [options, query, recentIds]
  )
  const sections = useMemo(
    () => sectionProjectOptions(matches, query, recentIds),
    [matches, query, recentIds]
  )
  // RR-c1: a stopped Create focuses the field without its path tooltip.
  useEffect(() => {
    if (focusSignal > 0) {
      quietFocus.current = true
      inputRef.current?.focus()
    }
  }, [focusSignal, inputRef])
  // "Choose a GitHub repository": open with the first cloud-only row armed (scrolled into view).
  useOpenOnSignal(openSignal, () => {
    inputRef.current?.focus()
    setOpen(true)
    if (cloudRepos?.[0]) {
      arm(cloudRepoKey(cloudRepos[0].fullName))
    }
  })
  const ambiguous = useMemo(() => getAmbiguousProjectOptionIds(options), [options])
  const cloudMatches = useMemo(
    () => (cloudRepos ? filterCloudRepos(cloudRepos, query) : []),
    [cloudRepos, query]
  )
  // A picked cloud-only repository stands in for the project in the field (D4).
  const selected = cloudRepoValue ? null : (options.find((option) => option.id === value) ?? null)
  const committed = (selected !== null || cloudRepoValue !== null) && query.length === 0
  const committedName = cloudRepoValue ?? selected?.displayName ?? ''

  const cloudRows = { cloudRepos, onShowMoreCloudRepos, onMoreCloudAccess, onCloudRepoSelected }
  const commit = (key: string | null): void => {
    if (key === null) {
      return
    }
    // Show more keeps the list open: the next page appends in place.
    const cloudRow = commitCloudRow(key, cloudRows)
    if (cloudRow === 'kept-open') {
      return
    }
    close()
    if (cloudRow === 'handled') {
      return
    }
    if (key === ADD_PROJECT_KEY) {
      onAddProject?.()
      return
    }
    onValueChange(key)
    onValueSelected?.(key)
  }

  // Arming a list row closes an open Add project cascade beside it.
  const armClosingCascade = (key: string): void => {
    setCascadeOpen(false)
    arm(key)
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void =>
    handleProjectComboboxKeyDown(event, {
      open,
      armedKey,
      query,
      committed,
      committedName,
      cascadeOpen,
      hasAddProjectMenu: Boolean(addProjectMenu),
      setOpen,
      setQuery,
      setCascadeOpen,
      setCascadeAutoFocus,
      moveArm,
      commit,
      close
    })

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <Tooltip
        open={tooltipOpen && committed && !open}
        onOpenChange={(next) => (next && quietFocus.current ? undefined : setTooltipOpen(next))}
      >
        <PopoverAnchor asChild>
          <TooltipTrigger asChild>
            <div
              data-project-combobox-root="true"
              // A pointer on the field ends the quiet focus: hover shows the tooltip again.
              onPointerEnter={() => {
                quietFocus.current = false
              }}
              onClick={() => {
                inputRef.current?.focus()
                setOpen(true)
              }}
              className={cn(
                COMBOBOX_FIELD_SHELL,
                // Invalid stays red while focused, so the field and its error read as one.
                invalid &&
                  'border-destructive ring-destructive/20 focus-within:border-destructive focus-within:ring-destructive/40 dark:ring-destructive/40',
                triggerClassName
              )}
            >
              <span className="flex w-4 shrink-0 items-center justify-center">
                {committed && selected ? <ProjectOptionMark option={selected} /> : null}
                {committed && cloudRepoValue ? (
                  <Github aria-hidden className="size-3.5 text-muted-foreground" />
                ) : null}
              </span>
              <div className="relative min-w-0 flex-1 overflow-hidden">
                <ImeInput
                  ref={inputRef}
                  type="text"
                  role="combobox"
                  data-project-combobox-root="true"
                  aria-label={t('auto.components.new.workspace.ProjectCombobox.label', 'Project')}
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
                  onBlur={(event) => {
                    quietFocus.current = false
                    const next = event.relatedTarget
                    // A parent dialog's trap can refocus this field as a nested dialog mounts; Radix misses focus that leaves before the list mounts.
                    if (
                      next instanceof Element &&
                      !isWithinComboboxRoot(next, ROOT_ATTRIBUTE) &&
                      !contentRef.current?.contains(next) &&
                      !isWithinAddProjectMenu(next)
                    ) {
                      close()
                    }
                  }}
                  onKeyDown={handleKeyDown}
                  className={cn(
                    'w-full min-w-0 bg-transparent text-sm outline-none placeholder:text-muted-foreground',
                    committed && 'text-transparent caret-foreground'
                  )}
                />
                {committed ? (
                  <div
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-0 flex min-w-0 items-center text-sm"
                  >
                    <span className="truncate">{committedName}</span>
                  </div>
                ) : null}
              </div>
              <button
                type="button"
                tabIndex={-1}
                aria-label={t(
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
          ref={contentRef}
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
            if (
              isWithinComboboxRoot(event.target, ROOT_ATTRIBUTE) ||
              isWithinAddProjectMenu(event.target)
            ) {
              event.preventDefault()
            }
          }}
          onInteractOutside={(event) => {
            if (
              isWithinComboboxRoot(event.target, ROOT_ATTRIBUTE) ||
              isWithinAddProjectMenu(event.target)
            ) {
              event.preventDefault()
            }
          }}
        >
          {/* Keep scrolling options and pinned Add under the same listbox. */}
          <div
            id={listId}
            role="listbox"
            aria-label={t('auto.components.new.workspace.ProjectCombobox.listLabel', 'Projects')}
            className="flex min-h-0 flex-col"
          >
            {/* Presentation preserves listbox ownership through this scrolling wrapper. */}
            <div
              ref={setListNode}
              role="presentation"
              className="max-h-72 min-h-0 flex-1 overflow-y-auto p-1 scrollbar-sleek"
            >
              {matches.length === 0 && cloudMatches.length === 0 ? (
                // Match row height so empty results stay visually neutral.
                <p className="flex h-8 items-center justify-center px-2 text-sm text-muted-foreground">
                  {options.length === 0
                    ? t(
                        'auto.components.new.workspace.ProjectCombobox.noProjects',
                        'No projects yet.'
                      )
                    : t(
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
                      onArm={() => armClosingCascade(scored.option.id)}
                      onCommit={() => commit(scored.option.id)}
                    />
                  ))}
                </div>
              ))}
              {cloudRepos ? (
                <ProjectComboboxCloudSection
                  repos={cloudMatches}
                  value={cloudRepoValue ? cloudRepoKey(cloudRepoValue) : null}
                  armedKey={armedKey}
                  armedId={`${listId}-armed`}
                  onArm={armClosingCascade}
                  onCommit={commit}
                  showMoreAccess={Boolean(onMoreCloudAccess)}
                  showMoreRepos={Boolean(onShowMoreCloudRepos)}
                />
              ) : null}
            </div>
            <ProjectComboboxAddProjectOption
              optionId={armedKey === ADD_PROJECT_KEY ? `${listId}-armed` : undefined}
              armed={armedKey === ADD_PROJECT_KEY}
              cascadeOpen={cascadeOpen}
              cascadeAutoFocus={cascadeAutoFocus}
              addProjectMenu={addProjectMenu}
              onAddProject={onAddProject}
              onArm={() => arm(ADD_PROJECT_KEY)}
              onCommitPlain={() => commit(ADD_PROJECT_KEY)}
              onCascadeOpenChange={setCascadeOpen}
              onCascadeAutoFocusChange={setCascadeAutoFocus}
              onCloseCombobox={close}
              onFocusSearchInput={() => inputRef.current?.focus()}
            />
          </div>
        </PopoverContent>
      ) : null}
    </Popover>
  )
}
