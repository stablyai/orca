import React from 'react'
import { ChevronDown, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import type { PrimaryAction } from './source-control-primary-action'
import type { DropdownActionKind, DropdownEntry } from './source-control-dropdown-items'

export function CommitPrimaryActions({
  showComposer,
  primaryAction,
  PrimaryIcon,
  showSpinner,
  showChevronSpinner,
  dropdownItems,
  moreCommitAndRemoteActionsLabel,
  moreActionsLabel,
  onPrimaryAction,
  onDropdownAction
}: {
  showComposer: boolean
  primaryAction: PrimaryAction
  PrimaryIcon?: React.ComponentType<{
    className?: string
    'aria-hidden'?: boolean | 'true' | 'false'
  }>
  showSpinner: boolean
  showChevronSpinner: boolean
  dropdownItems: DropdownEntry[]
  moreCommitAndRemoteActionsLabel: string
  moreActionsLabel: string
  onPrimaryAction: () => void
  onDropdownAction: (kind: DropdownActionKind) => void
}): React.JSX.Element {
  const dropdownMenuContent = (
    <DropdownMenuContent align="end" className="min-w-[14rem]">
      {dropdownItems.map((entry, index) =>
        entry.kind === 'separator' ? (
          <DropdownMenuSeparator key={`sep-${index}`} />
        ) : (
          <Tooltip key={entry.kind}>
            <TooltipTrigger asChild>
              <div className="block">
                <DropdownMenuItem
                  disabled={entry.disabled}
                  title={entry.title}
                  variant={entry.variant}
                  className="w-full"
                  onSelect={(event) => {
                    if (entry.disabled) {
                      event.preventDefault()
                      return
                    }
                    onDropdownAction(entry.kind)
                  }}
                >
                  <span className="flex min-w-0 flex-col">
                    <span>{entry.label}</span>
                    {entry.hint ? (
                      <span className="truncate text-[10px] text-muted-foreground">
                        {entry.hint}
                      </span>
                    ) : null}
                  </span>
                </DropdownMenuItem>
              </div>
            </TooltipTrigger>
            <TooltipContent side="left" sideOffset={8} className="max-w-72">
              {entry.title}
            </TooltipContent>
          </Tooltip>
        )
      )}
    </DropdownMenuContent>
  )

  return (
    <div
      className={cn(showComposer ? 'mt-1 flex items-stretch gap-1' : 'flex items-stretch gap-1')}
    >
      <div className="flex flex-1 items-stretch">
        {/* Why: match the hosted-review action buttons in Checks
            (size="xs", px-3 text-[11px]) so the sidebar has a consistent
            action-button shape across Source Control and Checks. */}
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="flex flex-1">
              <Button
                type="button"
                variant="outline"
                size="xs"
                disabled={primaryAction.disabled}
                onClick={() => onPrimaryAction()}
                className="w-full rounded-r-none px-3 text-[11px]"
                title={primaryAction.title}
              >
                {showSpinner ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : PrimaryIcon ? (
                  <PrimaryIcon className="size-3.5" aria-hidden="true" />
                ) : null}
                {primaryAction.label}
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={6} className="max-w-72">
            {primaryAction.title}
          </TooltipContent>
        </Tooltip>
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex shrink-0">
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    size="xs"
                    className={cn(
                      'rounded-l-none border-l border-border px-1.5 shrink-0',
                      // Why: mirror the primary's disabled dimming so the split
                      // button reads as one unit when Commit is unavailable. The
                      // chevron itself stays clickable — its dropdown exposes
                      // independently-gated remote actions (push / fetch / pull)
                      // that are still valid when the primary is disabled.
                      primaryAction.disabled && 'opacity-50'
                    )}
                    aria-label={moreCommitAndRemoteActionsLabel}
                    title={moreActionsLabel}
                  >
                    {showChevronSpinner ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <ChevronDown className="size-3.5" />
                    )}
                  </Button>
                </DropdownMenuTrigger>
              </span>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={6}>
              {moreCommitAndRemoteActionsLabel}
            </TooltipContent>
          </Tooltip>
          {dropdownMenuContent}
        </DropdownMenu>
      </div>
    </div>
  )
}
