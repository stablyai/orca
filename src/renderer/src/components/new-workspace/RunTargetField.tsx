import React from 'react'
import { ChevronDown, Cloud } from 'lucide-react'
import { PopoverAnchor } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { HostRowIcon } from './RunTargetComboboxRow'
import { COMBOBOX_FIELD_SHELL } from './type-ahead-combobox-styles'

/**
 * The run-target field: a text input that *is* the search box, painted over
 * with the committed selection so a long label and its path shrink at
 * different rates instead of truncating as one flat string.
 */
export default function RunTargetField({
  query,
  onQueryChange,
  open,
  onOpenRequest,
  onToggle,
  committed,
  isRecipe,
  hostId,
  label,
  detail,
  listId,
  hasArmedRow,
  inputRef,
  onKeyDown
}: {
  query: string
  onQueryChange: (value: string) => void
  open: boolean
  onOpenRequest: () => void
  onToggle: () => void
  committed: boolean
  isRecipe: boolean
  hostId: ExecutionHostId | null
  label: string
  detail: string
  listId: string
  hasArmedRow: boolean
  inputRef: React.RefObject<HTMLInputElement | null>
  onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => void
}): React.JSX.Element {
  return (
    <PopoverAnchor asChild>
      <div
        data-run-target-combobox-root="true"
        onClick={() => {
          inputRef.current?.focus()
          onOpenRequest()
        }}
        className={COMBOBOX_FIELD_SHELL}
      >
        <span className="flex w-4 shrink-0 items-center justify-center">
          {committed ? (
            isRecipe ? (
              <Cloud className="size-3.5 shrink-0 text-muted-foreground" />
            ) : hostId ? (
              <HostRowIcon hostId={hostId} />
            ) : null
          ) : null}
        </span>
        <div className="relative min-w-0 flex-1 overflow-hidden">
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            data-run-target-combobox-root="true"
            aria-label={translate(
              'auto.components.new.workspace.RunTargetCombobox.label',
              'Run on'
            )}
            aria-expanded={open}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={open && hasArmedRow ? `${listId}-armed` : undefined}
            value={query}
            placeholder={
              committed
                ? ''
                : translate(
                    'auto.components.NewWorkspaceComposerCard.chooseRunTarget',
                    'Choose target'
                  )
            }
            onChange={(event) => onQueryChange(event.target.value)}
            onFocus={onOpenRequest}
            onKeyDown={onKeyDown}
            className={cn(
              'w-full min-w-0 bg-transparent text-sm outline-none placeholder:text-muted-foreground',
              committed && 'text-transparent caret-foreground'
            )}
          />
          {committed ? (
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 flex items-center text-sm"
            >
              {/* Baseline-aligned: centring two type sizes leaves the smaller high. */}
              <div className="flex min-w-0 flex-1 items-baseline gap-2">
                <span className="min-w-0 max-w-[50%] shrink truncate">{label}</span>
                <span
                  className="min-w-0 flex-1 shrink-[999] truncate text-right text-xs text-muted-foreground"
                  title={detail}
                >
                  {detail}
                </span>
              </div>
            </div>
          ) : null}
        </div>
        <button
          type="button"
          tabIndex={-1}
          aria-label={translate(
            'auto.components.new.workspace.RunTargetCombobox.browse',
            'Browse run targets'
          )}
          onMouseDown={(event) => event.preventDefault()}
          onClick={(event) => {
            event.stopPropagation()
            inputRef.current?.focus()
            onToggle()
          }}
          className="-mr-1 flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <ChevronDown className={cn('size-3.5 transition-transform', open && 'rotate-180')} />
        </button>
      </div>
    </PopoverAnchor>
  )
}
