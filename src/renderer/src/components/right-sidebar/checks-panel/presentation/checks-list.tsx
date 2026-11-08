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
import { observeOffscreenAnimation } from '@/lib/offscreen-animation-pause'
import { useTranslate } from '@/i18n/use-translate'
import { CHECK_COLOR, CHECK_ICON } from './check-presentation'
import { CheckRunDetails } from './check-run-details'
import { CheckRunTime } from './check-run-time'
import { getCheckStatusLabel } from '@/components/github/pr-check-presentation'
import { getCheckConclusion } from '@/components/pr-check-counts'
import { type ChecksListProps, useChecksListState } from '../refresh/use-checks-list-state'
import {
  openAppHttpLink,
  openAppHttpLinkFromAnchor
} from '@/lib/browser/navigation/app-http-link-open'
import type { PRCheckDetail } from '../../../../../../shared/github/check-types'

export function ChecksList(props: ChecksListProps): React.JSX.Element {
  const t = useTranslate()
  const {
    checks,
    pipelineCheck,
    checksError,
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
    cancelledCount,
    pendingCount,
    neutralCount,
    toggleCheckExpanded,
    requestCheckDetails
  } = useChecksListState(props)
  return (
    <>
      {pipelineCheck && <PipelineCheckRow check={pipelineCheck} />}
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
              {t(
                'auto.components.right.sidebar.checks.panel.content.passingCount',
                '{{count}} passing',
                { count: passingCount, defaultValue_one: '{{count}} passing' }
              )}
            </span>
          )}
          {failingCount > 0 && (
            <span className="flex items-center gap-1">
              <CircleX className="size-3 text-rose-500" />
              {t(
                'auto.components.right.sidebar.checks.panel.content.failingCount',
                '{{count}} failing',
                { count: failingCount, defaultValue_one: '{{count}} failing' }
              )}
            </span>
          )}
          {cancelledCount > 0 && (
            <span className="flex items-center gap-1 text-muted-foreground">
              <CircleDashed className="size-3" />
              {cancelledCount}{' '}
              {t('auto.components.editor.CheckRunDetailsPanel.91a4c7e2b0', 'Cancelled')}
            </span>
          )}
          {pendingCount > 0 && (
            <span className="flex items-center gap-1">
              <LoaderCircle className="size-3 text-amber-500" />
              {t(
                'auto.components.right.sidebar.checks.panel.content.pendingCount',
                '{{count}} pending',
                { count: pendingCount, defaultValue_one: '{{count}} pending' }
              )}
            </span>
          )}
          {/* Name unresolved counts so an all-neutral list still explains its grey pill. */}
          {neutralCount > 0 && (
            <span className="flex items-center gap-1">
              <CircleDashed className="size-3 text-muted-foreground" />
              {t(
                'auto.components.right.sidebar.checks.panel.content.unresolvedCount',
                '{{count}} unresolved',
                { count: neutralCount, defaultValue_one: '{{count}} unresolved' }
              )}
            </span>
          )}
          <span className="flex-1" />
          {checksLoading && <LoaderCircle className="size-3 animate-spin text-muted-foreground" />}
        </button>
      )}

      {/* A kept parent stands in for an empty job list, but a failed read still reports itself. */}
      {pipelineCheck && checks.length === 0 && !checksError ? null : checksLoading &&
        checks.length === 0 &&
        !pipelineCheck ? (
        <div className="flex items-center justify-center py-8">
          <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : checks.length === 0 && checksError ? (
        <div role="alert" className="px-4 py-8 text-[11px] break-words text-destructive">
          {checksError}
        </div>
      ) : checks.length === 0 ? (
        <div className="px-4 py-8 text-[11px] text-muted-foreground">
          {t(
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
              const conclusion = getCheckConclusion(check)
              const expanded = expandedCheckKeys.has(row.key)
              const openUrl = check.url
              return (
                <div key={row.key} className="min-w-0">
                  <div
                    ref={conclusion === 'pending' ? observeOffscreenAnimation : undefined}
                    className={cn(
                      'group/check-row @container flex min-w-0 cursor-pointer items-center gap-2 px-3 py-1.5 transition-colors hover:bg-accent/40',
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
                    <CheckStatusIcon check={check} />
                    <span className="flex-1 truncate @[19rem]:min-w-9 text-[12px] text-foreground">
                      {check.name}
                    </span>
                    <CheckRunTime check={check} />
                    <span className="flex shrink-0 items-center gap-1">
                      {openUrl && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-xs"
                              className="size-6 text-muted-foreground hover:text-foreground focus-visible:text-foreground"
                              aria-label={t(
                                'auto.components.right.sidebar.checks.panel.content.0dca6bfab5',
                                'Open check details'
                              )}
                              onClick={(event) => {
                                event.stopPropagation()
                                openAppHttpLink(openUrl, { event })
                              }}
                            >
                              <ExternalLink className="size-3" />
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent side="left" sideOffset={4}>
                            {t(
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
              title={t(
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
              {t(
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

// The icon already shows the state, so its word lives in the icon's tooltip and accessible name, not beside it.
function CheckStatusIcon({ check }: { check: PRCheckDetail }): React.JSX.Element {
  const t = useTranslate()
  const conclusion = getCheckConclusion(check)
  const Icon = CHECK_ICON[conclusion] ?? CircleDashed
  const label = getCheckStatusLabel(check, t)
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span role="img" aria-label={label} className="flex shrink-0">
          <Icon
            className={cn(
              'size-3.5',
              CHECK_COLOR[conclusion] ?? 'text-muted-foreground',
              conclusion === 'pending' && 'animate-spin motion-reduce:animate-none'
            )}
          />
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}

// The parent pipeline opens on the provider; it has no inline job log to expand.
function PipelineCheckRow({ check }: { check: PRCheckDetail }): React.JSX.Element {
  const conclusion = getCheckConclusion(check)
  const content = (
    <>
      <CheckStatusIcon check={check} />
      <span className="flex-1 truncate @[19rem]:min-w-9 text-[12px] text-foreground">
        {check.name}
      </span>
      <CheckRunTime check={check} />
      {check.url && <ExternalLink className="size-3 shrink-0 text-muted-foreground" />}
    </>
  )
  const className = '@container flex min-w-0 items-center gap-2 border-b border-border px-3 py-1.5'
  const animationRef = conclusion === 'pending' ? observeOffscreenAnimation : undefined
  return check.url ? (
    <a
      ref={animationRef}
      href={check.url}
      onClick={openAppHttpLinkFromAnchor}
      className={cn(className, 'transition-colors hover:bg-accent/40')}
    >
      {content}
    </a>
  ) : (
    <div ref={animationRef} className={className}>
      {content}
    </div>
  )
}
