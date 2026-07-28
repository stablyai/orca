import React, { useCallback, useMemo } from 'react'
import { ChevronDown, FolderPlus } from 'lucide-react'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import type { NewWorkspaceProjectOption } from '@/lib/new-workspace-project-options'
import { translate } from '@/i18n/i18n'
import {
  getAmbiguousProjectOptionIds,
  rankProjectOptions,
  sectionProjectOptions
} from './project-combobox-matching'
import { ProjectOptionDetail, ProjectOptionMark, ProjectOptionRow } from './ProjectComboboxRow'
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

/**
 * Type-ahead project picker: the field *is* the search, so there's no trigger
 * wrapping a second search box. Exactly one row is armed at any time and Enter
 * takes it; hovering arms, so the pointer and the keyboard drive one cursor.
 * "Add a new project" is pinned to the popover edge so it stays reachable
 * without scrolling, in every state including no-matches and no-projects.
 */
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
  const recentIds = useRecentProjectIds()
  // Ranking depends on the query the hook owns, so rows are derived from it and
  // handed back; `matches`/`sections` are recomputed from the same query below.
  const deriveRowKeys = useCallback(
    (query: string): string[] => [
      ...rankProjectOptions(options, query, recentIds).map((match) => match.option.id),
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
  // A committed pick shows as the field's own content; typing replaces it.
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
      // Why: not gated on `open` — a leftover query with the list closed would
      // otherwise strand the field showing text that matches nothing and hides
      // the committed project. Escape always restores the committed display,
      // and only bubbles (to close the dialog) when there's nothing to undo.
      if (event.key === 'Escape' && (open || query.length > 0)) {
        event.preventDefault()
        event.stopPropagation()
        close()
        return
      }
      // Backspace on a committed pick unsticks it back into editable text.
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
      <PopoverAnchor asChild>
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
            <input
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
            {/* Painted over the input so a long name and its path can shrink at
                different rates instead of truncating as one flat string. */}
            {committed && selected ? (
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 flex items-center text-sm"
              >
                {/* Why: the outer row centres this group in the field, while the
                    group itself is baseline-aligned — centring two different
                    type sizes leaves the smaller one sitting visibly high. */}
                <div className="flex min-w-0 flex-1 items-baseline gap-2">
                  <span className="min-w-0 max-w-[50%] shrink truncate">
                    {selected.displayName}
                  </span>
                  <ProjectOptionDetail
                    detail={selected.detail}
                    className="min-w-0 flex-1 shrink-[999] justify-end text-xs text-muted-foreground"
                  />
                </div>
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
            <ChevronDown className={cn('size-3.5 transition-transform', open && 'rotate-180')} />
          </button>
        </div>
      </PopoverAnchor>
      <PopoverContent
        align="start"
        sideOffset={4}
        // Why opaque + no fade: this popover lands directly on the composer
        // dialog, not the app canvas. The shared surface is translucent and
        // fades 0→1, so mid-animation the Name field underneath reads straight
        // through the list — two layers at once, which is the "double flash".
        // An opaque surface that zooms without fading resolves it. (`bg-popover`
        // alone loses to the primitive's arbitrary-value background, hence the
        // matching arbitrary form.) Every other caller keeps the blur and fade.
        className={cn(
          'flex w-[var(--radix-popover-trigger-width)] min-w-[17rem] flex-col p-0',
          COMBOBOX_POPOVER_SURFACE
        )}
        // Focus stays in the field — it's the search box — so the popover must
        // not steal it on open, nor yank it back on close after a pick.
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        // Why: the field lives in the anchor, not inside the content, so Radix
        // sees a focus/pointer event "outside" the layer and dismisses it the
        // instant you tab in. Keep the layer open whenever the interaction is
        // within this control; genuine outside events still close it.
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
        {/* The listbox wraps a scrolling pane plus the pinned Add row, so both
            stay `option` children of one listbox. */}
        <div
          id={listId}
          role="listbox"
          aria-label={translate(
            'auto.components.new.workspace.ProjectCombobox.listLabel',
            'Projects'
          )}
          className="flex min-h-0 flex-col"
        >
          {/* Why: `presentation` — this element exists to scroll, and an
              unroled div between a listbox and its options breaks the
              ownership relationship assistive tech relies on. */}
          <div
            ref={setListNode}
            role="presentation"
            className="max-h-72 min-h-0 flex-1 overflow-y-auto p-1 scrollbar-sleek"
          >
            {matches.length === 0 ? (
              // Why: row-height rather than a tall centred block — a 60px panel
              // next to 32px rows reads as a different kind of surface and
              // makes an empty result feel like an error.
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
              // Why: `role="group"` — a bare div between a listbox and its
              // options breaks the ownership relationship for screen readers,
              // which is the only thing that makes the headings announceable.
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
                'flex h-9 shrink-0 cursor-default items-center gap-2 border-t border-border px-2 text-sm',
                armedKey === ADD_PROJECT_KEY && 'bg-accent text-accent-foreground'
              )}
            >
              <FolderPlus className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate">
                {translate(
                  'auto.components.new.workspace.ProjectCombobox.addProject',
                  'Add a new project'
                )}
              </span>
            </div>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  )
}
