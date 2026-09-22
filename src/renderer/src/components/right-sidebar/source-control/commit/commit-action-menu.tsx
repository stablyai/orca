import React from 'react'
import { ChevronDown, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import type { PrimaryAction } from '../../source-control-primary-action'
import { PrimaryActionTooltip } from '../../source-control-primary-action-tooltip'

export function CommitActionMenu({
  showComposer,
  primaryAction,
  PrimaryIcon,
  showSpinner,
  showChevronSpinner,
  moreCommitAndRemoteActionsLabel,
  dropdownMenuContent,
  onPrimaryAction
}: {
  showComposer: boolean
  primaryAction: PrimaryAction
  PrimaryIcon?: React.ComponentType<{
    className?: string
    'aria-hidden'?: boolean | 'true' | 'false'
  }>
  showSpinner: boolean
  showChevronSpinner: boolean
  moreCommitAndRemoteActionsLabel: string
  dropdownMenuContent: React.ReactNode
  onPrimaryAction: () => void
}): React.JSX.Element {
  return (
    // Why: action + chevron form one split button so the edit → commit → push loop stays in a single vertical band.
    <div className={cn('flex items-stretch gap-1', showComposer && 'mt-1')}>
      <div className="flex flex-1 items-stretch">
        <PrimaryActionTooltip action={primaryAction} side="top">
          <span className="flex flex-1">
            <Button
              type="button"
              variant="outline"
              size="xs"
              disabled={primaryAction.disabled}
              onClick={() => onPrimaryAction()}
              className="w-full rounded-r-none px-3 text-[11px]"
            >
              {showSpinner ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : PrimaryIcon ? (
                <PrimaryIcon className="size-3.5" aria-hidden="true" />
              ) : null}
              {primaryAction.label}
            </Button>
          </span>
        </PrimaryActionTooltip>
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
                      // Why: mirror the primary's disabled dimming for a unified look, but the chevron stays clickable (its push/fetch/pull stay valid when Commit is disabled).
                      primaryAction.disabled && 'opacity-50'
                    )}
                    aria-label={moreCommitAndRemoteActionsLabel}
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
