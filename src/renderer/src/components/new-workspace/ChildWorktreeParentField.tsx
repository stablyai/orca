import React, { useCallback, useMemo } from 'react'
import { ChevronDown, GitFork } from 'lucide-react'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { Switch } from '@/components/ui/switch'
import { translate } from '@/i18n/i18n'
import { isImeCompositionKeyDown } from '@/lib/ime-composition-keyboard-event'
import { cn } from '@/lib/utils'
import type { Worktree } from '../../../../shared/types'
import {
  rankChildWorktreeParentCandidates,
  sectionChildWorktreeParentCandidates
} from './child-worktree-parent-options'
import { COMBOBOX_FIELD_SHELL, COMBOBOX_POPOVER_SURFACE } from './type-ahead-combobox-styles'
import { isWithinComboboxRoot, useTypeAheadCombobox } from './use-type-ahead-combobox'
import { ChildWorktreeParentRow, childWorktreeParentBranchLabel } from './ChildWorktreeParentRow'

type ChildWorktreeParentFieldProps = {
  candidates: readonly Worktree[]
  enabled: boolean
  selectionSupported: boolean
  value: string | null
  activeWorktreeId: string | null
  lastVisitedAtByWorktreeId: Readonly<Record<string, number>>
  onEnabledChange: (enabled: boolean) => void
  onValueChange: (worktreeId: string) => void
}

type ParentWorktreeComboboxProps = Pick<
  ChildWorktreeParentFieldProps,
  'activeWorktreeId' | 'candidates' | 'lastVisitedAtByWorktreeId' | 'onValueChange' | 'value'
> & {
  inputId: string
  selectedDescriptionId: string
}

const ROOT_ATTRIBUTE = 'data-child-worktree-parent-combobox-root'

function ParentWorktreeCombobox({
  candidates,
  value,
  activeWorktreeId,
  lastVisitedAtByWorktreeId,
  onValueChange,
  inputId,
  selectedDescriptionId
}: ParentWorktreeComboboxProps): React.JSX.Element {
  const deriveRowKeys = useCallback(
    (query: string): string[] =>
      rankChildWorktreeParentCandidates(candidates, query, lastVisitedAtByWorktreeId).map(
        (candidate) => candidate.id
      ),
    [candidates, lastVisitedAtByWorktreeId]
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
  const ranked = useMemo(
    () => rankChildWorktreeParentCandidates(candidates, query, lastVisitedAtByWorktreeId),
    [candidates, lastVisitedAtByWorktreeId, query]
  )
  const sections = useMemo(
    () => sectionChildWorktreeParentCandidates(ranked, query),
    [query, ranked]
  )
  const selected = candidates.find((candidate) => candidate.id === value) ?? null
  const committed = selected !== null && query.length === 0

  const commit = useCallback(
    (worktreeId: string | null): void => {
      if (!worktreeId) {
        return
      }
      close()
      onValueChange(worktreeId)
    },
    [close, onValueChange]
  )

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>): void => {
      if (isImeCompositionKeyDown(event)) {
        return
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        setOpen(true)
        moveArm(event.key === 'ArrowDown' ? 1 : -1)
      } else if (event.key === 'Enter' && open) {
        event.preventDefault()
        commit(armedKey)
      } else if (event.key === 'Escape' && (open || query.length > 0)) {
        event.preventDefault()
        event.stopPropagation()
        close()
      } else if (event.key === 'Backspace' && committed && selected) {
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
          data-child-worktree-parent-combobox-root="true"
          onClick={() => {
            inputRef.current?.focus()
            setOpen(true)
          }}
          className={COMBOBOX_FIELD_SHELL}
        >
          <GitFork className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <div className="relative min-w-0 flex-1 overflow-hidden">
            <input
              id={inputId}
              ref={inputRef}
              type="text"
              role="combobox"
              data-child-worktree-parent-combobox-root="true"
              aria-expanded={open}
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={open && armedKey ? `${listId}-armed` : undefined}
              aria-describedby={committed && selected ? selectedDescriptionId : undefined}
              value={query}
              placeholder={
                committed
                  ? ''
                  : translate(
                      'auto.components.new.workspace.ChildWorktreeParentField.placeholder',
                      'Choose a parent worktree'
                    )
              }
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
              <>
                <div
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-0 flex min-w-0 items-baseline gap-2 text-sm"
                >
                  <span className="min-w-0 flex-1 truncate">{selected.displayName}</span>
                  <span className="max-w-[45%] shrink truncate text-xs text-muted-foreground">
                    {childWorktreeParentBranchLabel(selected)}
                  </span>
                </div>
                <span id={selectedDescriptionId} className="sr-only">
                  {translate(
                    'auto.components.new.workspace.ChildWorktreeParentField.selectedParent',
                    'Selected parent: {{value0}} on {{value1}}',
                    {
                      value0: selected.displayName,
                      value1: childWorktreeParentBranchLabel(selected)
                    }
                  )}
                </span>
              </>
            ) : null}
          </div>
          <button
            type="button"
            tabIndex={-1}
            aria-label={translate(
              'auto.components.new.workspace.ChildWorktreeParentField.browse',
              'Browse parent worktrees'
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
        className={cn(
          'flex w-[var(--radix-popover-trigger-width)] min-w-[19rem] flex-col p-0',
          COMBOBOX_POPOVER_SURFACE
        )}
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
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
        <div
          id={listId}
          role="listbox"
          aria-label={translate(
            'auto.components.new.workspace.ChildWorktreeParentField.listLabel',
            'Parent worktrees'
          )}
          ref={setListNode}
          className="max-h-72 overflow-y-auto p-1 scrollbar-sleek"
        >
          {ranked.length === 0 ? (
            <p className="flex h-10 items-center justify-center px-2 text-sm text-muted-foreground">
              {translate(
                'auto.components.new.workspace.ChildWorktreeParentField.empty',
                'No worktrees match your search.'
              )}
            </p>
          ) : null}
          {sections.map((section) => {
            const heading =
              section.key === 'recent'
                ? translate(
                    'auto.components.new.workspace.ChildWorktreeParentField.recent',
                    'Recent'
                  )
                : section.key === 'all'
                  ? translate(
                      'auto.components.new.workspace.ChildWorktreeParentField.all',
                      'All worktrees'
                    )
                  : null
            return (
              <div key={section.key} role="group" aria-label={heading ?? undefined}>
                {heading ? (
                  <div
                    aria-hidden="true"
                    className="px-2 pt-2.5 pb-1 text-[11px] font-semibold tracking-[0.05em] text-muted-foreground uppercase"
                  >
                    {heading}
                  </div>
                ) : null}
                {section.items.map((worktree) => (
                  <ChildWorktreeParentRow
                    key={worktree.id}
                    worktree={worktree}
                    armed={armedKey === worktree.id}
                    selected={value === worktree.id}
                    current={activeWorktreeId === worktree.id}
                    optionId={armedKey === worktree.id ? `${listId}-armed` : undefined}
                    onArm={() => arm(worktree.id)}
                    onCommit={() => commit(worktree.id)}
                  />
                ))}
              </div>
            )
          })}
        </div>
      </PopoverContent>
    </Popover>
  )
}

export default function ChildWorktreeParentField({
  candidates,
  enabled,
  selectionSupported,
  value,
  activeWorktreeId,
  lastVisitedAtByWorktreeId,
  onEnabledChange,
  onValueChange
}: ChildWorktreeParentFieldProps): React.JSX.Element {
  const switchId = React.useId()
  const labelId = React.useId()
  const descriptionId = React.useId()
  const parentInputId = React.useId()
  const selectedDescriptionId = React.useId()
  const unavailable = !selectionSupported || candidates.length === 0

  return (
    <section className="rounded-lg border border-border bg-muted/20 px-3 py-3">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <label id={labelId} htmlFor={switchId} className="block text-xs font-medium">
            {translate(
              'auto.components.new.workspace.ChildWorktreeParentField.toggleLabel',
              'Make this a child worktree'
            )}
          </label>
          <p id={descriptionId} className="text-[11px] text-muted-foreground">
            {!selectionSupported
              ? translate(
                  'auto.components.new.workspace.ChildWorktreeParentField.updateRequired',
                  'Update the connected Orca server to choose a child worktree parent.'
                )
              : unavailable
                ? translate(
                    'auto.components.new.workspace.ChildWorktreeParentField.unavailable',
                    'No eligible parent worktrees on this project and host.'
                  )
                : translate(
                    'auto.components.new.workspace.ChildWorktreeParentField.description',
                    'Group this worktree under a parent.'
                  )}
          </p>
        </div>
        <Switch
          id={switchId}
          checked={enabled}
          disabled={unavailable}
          aria-labelledby={labelId}
          aria-describedby={descriptionId}
          onCheckedChange={onEnabledChange}
        />
      </div>
      <div
        className={cn(
          'grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none',
          enabled ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
        )}
      >
        <div className="min-h-0 overflow-hidden">
          {enabled ? (
            <div className="space-y-1 pt-3">
              <label
                htmlFor={parentInputId}
                className="block text-xs font-medium text-muted-foreground"
              >
                {translate(
                  'auto.components.new.workspace.ChildWorktreeParentField.parentLabel',
                  'Parent worktree'
                )}
              </label>
              <ParentWorktreeCombobox
                candidates={candidates}
                value={value}
                inputId={parentInputId}
                selectedDescriptionId={selectedDescriptionId}
                activeWorktreeId={activeWorktreeId}
                lastVisitedAtByWorktreeId={lastVisitedAtByWorktreeId}
                onValueChange={onValueChange}
              />
            </div>
          ) : null}
        </div>
      </div>
    </section>
  )
}
