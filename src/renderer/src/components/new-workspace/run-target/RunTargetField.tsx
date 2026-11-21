import { ImeInput } from '@/lib/text-input/ime/ime-text-field'
import React, { useId, useState } from 'react'
import { ChevronDown, Cloud } from 'lucide-react'
import { PopoverAnchor } from '@/components/ui/popover'
import { cn } from '@/lib/class-names'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import type { ExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import { HostRowIcon } from '../../host-picker/host-row-icon'
import { COMBOBOX_FIELD_SHELL } from '../type-ahead/type-ahead-combobox-styles'
import { MiddleEllipsisLabel } from './MiddleEllipsisLabel'

/** Overlay the committed selection while keeping the input ready to search. */
export default function RunTargetField({
  fieldName,
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
  onKeyDown,
  truncateMiddle = false
}: {
  fieldName?: string
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
  /** A long label loses its middle rather than its end. */
  truncateMiddle?: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const [tooltipOpen, setTooltipOpen] = useState(false)
  // The visible name is drawn over the search input and hidden from assistive tech, so the committed
  // target is its description: it holds whatever is typed or highlighted, until a row is picked.
  const committedId = useId()
  return (
    <Tooltip open={tooltipOpen && committed && !open} onOpenChange={setTooltipOpen}>
      <PopoverAnchor asChild>
        <TooltipTrigger asChild>
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
              {label ? (
                <span id={committedId} className="sr-only">
                  {label}
                </span>
              ) : null}
              <ImeInput
                ref={inputRef}
                type="text"
                role="combobox"
                data-run-target-combobox-root="true"
                aria-label={
                  fieldName ?? t('auto.components.new.workspace.RunTargetCombobox.label', 'Run on')
                }
                aria-expanded={open}
                aria-controls={listId}
                aria-autocomplete="list"
                aria-activedescendant={open && hasArmedRow ? `${listId}-armed` : undefined}
                aria-describedby={label ? committedId : undefined}
                value={query}
                placeholder={
                  committed
                    ? ''
                    : t('auto.components.NewWorkspaceComposerCard.chooseRunTarget', 'Choose target')
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
                  {truncateMiddle ? (
                    <MiddleEllipsisLabel text={label} />
                  ) : (
                    <span className="min-w-0 truncate">{label}</span>
                  )}
                </div>
              ) : null}
            </div>
            <button
              type="button"
              tabIndex={-1}
              aria-label={t(
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
        </TooltipTrigger>
      </PopoverAnchor>
      {committed ? (
        <TooltipContent side="top" sideOffset={4} className="max-w-96 break-all">
          <div className="font-medium">{label}</div>
          <div>{detail}</div>
        </TooltipContent>
      ) : null}
    </Tooltip>
  )
}
