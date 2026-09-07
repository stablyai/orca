import React from 'react'
import { ChevronDown, Loader2 } from 'lucide-react'
import { ShortcutKeyCombo } from '@/components/ShortcutKeyCombo'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { getScreenSubmitModifierLabel } from '@/lib/screen-submit-shortcut'
import { cn } from '@/lib/utils'
import type { PrimaryAction } from '../../source-control-primary-action'

export function CommitActionMenu({
  showComposer,
  primaryAction,
  PrimaryIcon,
  showSpinner,
  showChevronSpinner,
  moreCommitAndRemoteActionsLabel,
  moreActionsLabel,
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
  moreActionsLabel: string
  dropdownMenuContent: React.ReactNode
  onPrimaryAction: () => void
}): React.JSX.Element {
  return (
    // Why: action + chevron form one split button so the edit → commit → push loop stays in a single vertical band.
    <div className={cn('flex items-stretch gap-1', showComposer && 'mt-1')}>
      <div className="flex flex-1 items-stretch">
        {/* Why: match the Checks hosted-review buttons so action-button shape is consistent across Source Control and Checks. */}
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
          <TooltipContent side="top" sideOffset={6} className="flex max-w-72 items-center gap-2">
            <span>{primaryAction.title}</span>
            {primaryAction.kind === 'commit' ? (
              <ShortcutKeyCombo keys={[getScreenSubmitModifierLabel(), 'Enter']} />
            ) : null}
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
                      // Why: mirror the primary's disabled dimming for a unified look, but the chevron stays clickable (its push/fetch/pull stay valid when Commit is disabled).
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
