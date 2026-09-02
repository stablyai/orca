import React from 'react'
import { ChevronDown, LoaderCircle, RefreshCw, Wrench } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'

export function buildChecksToolbar({
  variant,
  canUseChecksRepoContext,
  refreshing,
  rerunning,
  fixingChecks,
  canFixBrokenChecks,
  failedChecksCount,
  listLength,
  onRefresh,
  onFix,
  onRerun
}: {
  variant: 'compact' | 'page'
  canUseChecksRepoContext: boolean
  refreshing: boolean
  rerunning: boolean
  fixingChecks: boolean
  canFixBrokenChecks: boolean
  failedChecksCount: number
  listLength: number
  onRefresh: () => void
  onFix: () => void
  onRerun: (failedOnly: boolean) => void
}): {
  refreshAction: React.JSX.Element
  fixBrokenChecksAction: React.JSX.Element | null
  rerunAction: React.JSX.Element | null
  secondaryActions: React.JSX.Element | null
  actions: React.JSX.Element
} {
  const refreshAction = (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="size-7 shrink-0"
          disabled={!canUseChecksRepoContext || refreshing}
          onClick={onRefresh}
          aria-label={translate('auto.components.PullRequestPage.5d0f42766d', 'Refresh checks')}
        >
          <RefreshCw className={cn('size-3.5', refreshing && 'animate-spin')} />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        {translate('auto.components.PullRequestPage.5d0f42766d', 'Refresh checks')}
      </TooltipContent>
    </Tooltip>
  )
  const fixBrokenChecksAction =
    failedChecksCount > 0 || fixingChecks ? (
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="xs"
            className="h-7 gap-1 px-2 text-[11px]"
            disabled={!canFixBrokenChecks || fixingChecks}
            onClick={onFix}
          >
            {fixingChecks ? (
              <LoaderCircle className="size-3 animate-spin" />
            ) : (
              <Wrench className="size-3" />
            )}
            {variant === 'compact'
              ? translate('auto.components.PullRequestPage.c808db1dd1', 'Fix checks')
              : translate('auto.components.PullRequestPage.a4541fd3db', 'Fix broken checks')}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6}>
          {translate(
            'auto.components.PullRequestPage.0fa8b8faec',
            'Start the default AI agent on these checks'
          )}
        </TooltipContent>
      </Tooltip>
    ) : null
  const rerunAction =
    listLength > 0 || rerunning ? (
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="xs"
            className="h-7 gap-1 px-2 text-[11px]"
            disabled={!canUseChecksRepoContext || rerunning || listLength === 0}
          >
            {rerunning ? (
              <LoaderCircle className="size-3 animate-spin" />
            ) : (
              <RefreshCw className="size-3" />
            )}
            {translate('auto.components.PullRequestPage.522d9353e1', 'Rerun')}
            <ChevronDown className="size-3 opacity-60" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44">
          <DropdownMenuItem
            disabled={failedChecksCount === 0 || rerunning}
            onSelect={() => onRerun(true)}
          >
            <RefreshCw className="size-4" />
            {translate('auto.components.PullRequestPage.68605516dd', 'Rerun failed checks')}
          </DropdownMenuItem>
          <DropdownMenuItem disabled={rerunning} onSelect={() => onRerun(false)}>
            <RefreshCw className="size-4" />
            {translate('auto.components.PullRequestPage.54cddd1858', 'Rerun all checks')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    ) : null
  const secondaryActions =
    variant === 'compact' && !fixBrokenChecksAction ? null : fixBrokenChecksAction ||
      rerunAction ? (
      <div className="flex min-w-0 flex-wrap items-center justify-end gap-1.5">
        {fixBrokenChecksAction}
        {variant === 'page' ? rerunAction : null}
      </div>
    ) : null
  const actions = (
    <div className="flex min-w-0 flex-wrap items-center justify-end gap-1.5">
      {refreshAction}
      {fixBrokenChecksAction}
      {rerunAction}
    </div>
  )
  return { refreshAction, fixBrokenChecksAction, rerunAction, secondaryActions, actions }
}

export function ChecksCompactHeader({
  SummaryIcon,
  summaryColor,
  summaryLabel,
  counts,
  listLength,
  refreshAction,
  rerunAction,
  secondaryActions
}: {
  SummaryIcon: React.ComponentType<{ className?: string }>
  summaryColor: string
  summaryLabel: string
  counts: { pending: number; failing: number }
  listLength: number
  refreshAction: React.JSX.Element
  rerunAction: React.JSX.Element | null
  secondaryActions: React.JSX.Element | null
}): React.JSX.Element {
  return (
    <div className="border-b border-border/50 px-3 py-2">
      <div className="flex min-w-0 items-start gap-2">
        <div className="flex min-w-0 flex-1 items-start gap-2">
          <SummaryIcon
            className={cn(
              'mt-0.5 size-3.5 shrink-0',
              summaryColor,
              counts.pending > 0 && counts.failing === 0 && 'animate-spin'
            )}
          />
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-medium leading-5 text-foreground">
              {translate('auto.components.PullRequestPage.94d95cf1f7', 'Checks')}
            </div>
            {listLength > 0 && (
              <div className="truncate text-[11px] leading-4 text-muted-foreground">
                {summaryLabel}
              </div>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {refreshAction}
          {listLength > 0 && (
            <div className="[&_button]:h-7 [&_button]:px-2 [&_button]:text-[11px]">
              {rerunAction}
            </div>
          )}
        </div>
      </div>
      {secondaryActions ? (
        <div className="mt-2 flex min-w-0 justify-end">{secondaryActions}</div>
      ) : null}
    </div>
  )
}
