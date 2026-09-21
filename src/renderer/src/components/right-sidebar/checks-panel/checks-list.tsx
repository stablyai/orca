import React from 'react'
import {
  ChevronDown,
  ChevronRight,
  CircleCheck,
  CircleDashed,
  CircleX,
  ExternalLink,
  LoaderCircle
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { CHECK_COLOR, CHECK_ICON } from './check-presentation'
import { CheckRunDetails } from './check-run-details'
import { getCheckStatusLabel } from './check-details-model'
import { type ChecksListProps, useChecksListState } from './use-checks-list-state'

export function ChecksList(props: ChecksListProps): React.JSX.Element {
  const {
    checks,
    checksLoading,
    checkDetailsContextKey,
    detailsStickySurface = 'sidebar',
    getGitLabProjectRef,
    githubRepository
  } = props
  const {
    resolvedWorktreeId,
    checksExpanded,
    setChecksExpanded,
    expandedCheckKeys,
    detailsByCheckKey,
    shouldConstrainCheckList,
    detailsHeight,
    handleResizeStart,
    rows,
    passingCount,
    failingCount,
    pendingCount,
    neutralCount,
    toggleCheckExpanded,
    requestCheckDetails
  } = useChecksListState(props)
  return (
    <>
      {/* Checks Summary */}
      {checks.length > 0 && (
        <button
          type="button"
          className="flex w-full items-center gap-3 border-b border-border px-3 py-2 text-left text-[10px] text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground"
          onClick={() => setChecksExpanded((expanded) => !expanded)}
          aria-expanded={checksExpanded}
        >
          <ChevronDown
            className={cn('size-3 shrink-0 transition-transform', !checksExpanded && '-rotate-90')}
          />
          {passingCount > 0 && (
            <span className="flex items-center gap-1">
              <CircleCheck className="size-3 text-emerald-500" />
              {passingCount}{' '}
              {translate(
                'auto.components.right.sidebar.checks.panel.content.02ca4f9074',
                'passing'
              )}
            </span>
          )}
          {failingCount > 0 && (
            <span className="flex items-center gap-1">
              <CircleX className="size-3 text-rose-500" />
              {failingCount}{' '}
              {translate(
                'auto.components.right.sidebar.checks.panel.content.5e52f4ef7f',
                'failing'
              )}
            </span>
          )}
          {pendingCount > 0 && (
            <span className="flex items-center gap-1">
              <LoaderCircle className="size-3 text-amber-500" />
              {pendingCount}{' '}
              {translate(
                'auto.components.right.sidebar.checks.panel.content.9ad98f2a17',
                'pending'
              )}
            </span>
          )}
          {/* Why: without this chip a list of only unresolved checks rendered a header with no
              counts at all, so nothing said why the pill was grey. */}
          {neutralCount > 0 && (
            <span className="flex items-center gap-1">
              <CircleDashed className="size-3 text-muted-foreground" />
              {neutralCount}{' '}
              {translate(
                'auto.components.right.sidebar.checks.panel.content.checksUnresolvedChip',
                'unresolved'
              )}
            </span>
          )}
          <span className="flex-1" />
          {checksLoading && <LoaderCircle className="size-3 animate-spin text-muted-foreground" />}
        </button>
      )}

      {/* Checks List */}
      {checksLoading && checks.length === 0 ? (
        <div className="flex items-center justify-center py-8">
          <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : checks.length === 0 ? (
        <div className="px-4 py-8 text-[11px] text-muted-foreground">
          {translate(
            'auto.components.right.sidebar.checks.panel.content.991f50c7e4',
            'No checks configured'
          )}
        </div>
      ) : !checksExpanded ? null : (
        <>
          <div
            className={cn('py-1', shouldConstrainCheckList && 'overflow-y-auto scrollbar-sleek')}
            style={shouldConstrainCheckList ? { maxHeight: detailsHeight } : undefined}
          >
            {rows.map((row) => {
              const check = row.check
              const conclusion = check.conclusion ?? 'pending'
              const Icon = CHECK_ICON[conclusion] ?? CircleDashed
              const color = CHECK_COLOR[conclusion] ?? 'text-muted-foreground'
              const expanded = expandedCheckKeys.has(row.key)
              const openUrl = check.url
              return (
                <div key={row.key} className="min-w-0">
                  <div
                    className={cn(
                      'group/check-row flex min-w-0 cursor-pointer items-center gap-2 px-3 py-1.5 transition-colors hover:bg-accent/40',
                      expanded && 'bg-accent/25'
                    )}
                    onClick={() => toggleCheckExpanded(row)}
                  >
                    <ChevronRight
                      className={cn(
                        'size-3 shrink-0 text-muted-foreground transition-transform',
                        expanded && 'rotate-90'
                      )}
                    />
                    <Icon
                      className={cn(
                        'size-3.5 shrink-0',
                        color,
                        conclusion === 'pending' && 'animate-spin'
                      )}
                    />
                    <span className="flex-1 truncate text-[12px] text-foreground">
                      {check.name}
                    </span>
                    <span className="flex shrink-0 items-center gap-1">
                      <span className="text-[11px] text-muted-foreground">
                        {getCheckStatusLabel(check)}
                      </span>
                      {openUrl && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-xs"
                              className="size-6 text-muted-foreground hover:text-foreground focus-visible:text-foreground"
                              aria-label={translate(
                                'auto.components.right.sidebar.checks.panel.content.0dca6bfab5',
                                'Open check details'
                              )}
                              onClick={(event) => {
                                event.stopPropagation()
                                window.api.shell.openUrl(openUrl)
                              }}
                            >
                              <ExternalLink className="size-3" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent side="left" sideOffset={4}>
                            {translate(
                              'auto.components.right.sidebar.checks.panel.content.0dca6bfab5',
                              'Open check details'
                            )}
                          </TooltipContent>
                        </Tooltip>
                      )}
                    </span>
                  </div>
                  {expanded && (
                    <CheckRunDetails
                      check={check}
                      state={detailsByCheckKey[row.key]}
                      checkDetailsContextKey={checkDetailsContextKey}
                      worktreeId={resolvedWorktreeId}
                      detailsStickySurface={detailsStickySurface}
                      getGitLabProjectRef={getGitLabProjectRef}
                      githubRepository={githubRepository}
                      onRetry={() => requestCheckDetails(row)}
                    />
                  )}
                </div>
              )
            })}
          </div>
          {shouldConstrainCheckList && (
            <div
              role="separator"
              aria-orientation="horizontal"
              title={translate(
                'auto.components.right.sidebar.checks.panel.content.7f793b571d',
                'Drag to resize checks'
              )}
              className="group flex h-2 cursor-row-resize items-center border-b border-border"
              onMouseDown={handleResizeStart}
            >
              <div className="h-px w-full bg-transparent transition-colors group-hover:bg-ring/40" />
            </div>
          )}
          {checks.length >= 100 && (
            <div className="border-b border-border px-3 py-1.5 text-[10px] text-muted-foreground">
              {translate(
                'auto.components.right.sidebar.checks.panel.content.cbcc4ab3db',
                'Showing first 100 checks'
              )}
            </div>
          )}
        </>
      )}
    </>
  )
}
