import React from 'react'
import { ChevronDown, ChevronRight, Globe, Trash2, X } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { BrowserWorkspace } from '../../../../shared/browser-workspace-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { ORPHAN_WORKTREE_ID } from '../../../../shared/constants'
import { UNATTRIBUTED_REPO_ID } from './mergeSnapshotAndSessions'
import type { UnifiedSessionRow, UnifiedWorktreeRow } from './resource-usage-merge-types'
import { isResourceSessionActivationKey } from './resource-session-navigation'
import {
  ResourceUsageMetricPair,
  ResourceUsageSparkline,
  ROW_TRAILING_GUTTER_CLS
} from './ResourceUsageMetrics'

export function ResourceUsageSessionRow({
  session,
  worktreeId,
  onNavigate,
  onKill
}: {
  session: UnifiedSessionRow
  worktreeId: string
  onNavigate: (tabId: string, paneKey: string | null) => void
  onKill: (session: UnifiedSessionRow) => void
}): React.JSX.Element {
  const clickable = session.tabId !== null && session.bound
  const handleClick = (): void => {
    if (clickable && session.tabId) {
      onNavigate(session.tabId, session.paneKey)
    }
  }

  return (
    <div
      className={cn(
        'group/sessrow flex items-center gap-2 pl-10 pr-3 py-1.5',
        clickable && 'cursor-pointer hover:bg-accent/40'
      )}
      onClick={clickable ? handleClick : undefined}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : -1}
      onKeyDown={
        clickable
          ? (event) => {
              if (isResourceSessionActivationKey(event.key)) {
                event.preventDefault()
                handleClick()
              }
            }
          : undefined
      }
      data-worktree-id={worktreeId}
    >
      <span
        className={cn(
          'size-1.5 shrink-0 rounded-full',
          session.bound ? 'bg-emerald-500' : 'bg-muted-foreground/40'
        )}
      />
      <span className="text-[11px] text-muted-foreground truncate min-w-0 flex-1">
        {session.label}
      </span>
      <ResourceUsageMetricPair cpu={session.cpu} memory={session.memory} size="small" />
      {/* Why: the shared gutter aligns columns while keeping orphan kills visible. */}
      <span className={ROW_TRAILING_GUTTER_CLS}>
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation()
            onKill(session)
          }}
          className={cn(
            'rounded p-0.5 text-muted-foreground transition-opacity hover:bg-destructive/10 hover:text-destructive',
            session.bound &&
              'can-hover:opacity-0 group-hover/sessrow:opacity-100 group-focus-within/sessrow:opacity-100 focus-visible:opacity-100'
          )}
          aria-label={translate(
            'auto.components.status.bar.ResourceUsageStatusSegment.fa6d36758d',
            'Kill session {{value0}}',
            { value0: session.sessionId }
          )}
        >
          <X className="size-3" />
        </button>
      </span>
    </div>
  )
}

function BrowserRow({ browser }: { browser: BrowserWorkspace }): React.JSX.Element {
  const label = browser.title?.trim() || browser.label?.trim() || browser.url
  return (
    <div className="flex items-center gap-2 pl-10 pr-3 py-1.5">
      <Globe className="size-3 shrink-0 text-muted-foreground" aria-hidden />
      <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">{label}</span>
      <ResourceUsageMetricPair cpu={null} memory={null} size="small" />
      <span className={ROW_TRAILING_GUTTER_CLS} aria-hidden />
    </div>
  )
}

export function ResourceUsageWorktreeRow({
  worktree,
  storeRecord,
  activeWorktreeId,
  isCollapsed,
  onToggle,
  onNavigate,
  onDelete,
  onKillSession,
  navigateToTab
}: {
  worktree: UnifiedWorktreeRow
  storeRecord: Worktree | null
  activeWorktreeId: string | null
  isCollapsed: boolean
  onToggle: () => void
  onNavigate: () => void
  onDelete: () => void
  onKillSession: (session: UnifiedSessionRow) => void
  navigateToTab: (tabId: string, paneKey: string | null) => void
}): React.JSX.Element {
  const hasResources = worktree.sessions.length > 0 || worktree.browsers.length > 0
  const isSynthetic =
    worktree.worktreeId === ORPHAN_WORKTREE_ID || worktree.repoId === UNATTRIBUTED_REPO_ID
  const isNavigable = !isSynthetic
  const showWorktreeActions =
    !isSynthetic && storeRecord !== null && worktree.worktreeId !== activeWorktreeId
  const isMainWorktree = storeRecord?.isMainWorktree ?? false
  const rowLabel = storeRecord?.displayName?.trim() || worktree.worktreeName

  return (
    <div className="border-b border-border/20 last:border-b-0">
      <div className="group/wtrow flex items-center ml-2 transition-colors hover:bg-muted/60">
        {hasResources ? (
          <button
            type="button"
            onClick={onToggle}
            className="pl-2 py-2 pr-0.5 shrink-0"
            aria-label={
              isCollapsed
                ? translate(
                    'auto.components.status.bar.ResourceUsageStatusSegment.c4a8968bdd',
                    'Expand workspace'
                  )
                : translate(
                    'auto.components.status.bar.ResourceUsageStatusSegment.bbcd9b7b85',
                    'Collapse workspace'
                  )
            }
          >
            {isCollapsed ? (
              <ChevronRight className="h-3 w-3 text-muted-foreground" />
            ) : (
              <ChevronDown className="h-3 w-3 text-muted-foreground" />
            )}
          </button>
        ) : (
          <span
            className="pl-2 py-2 pr-0.5 shrink-0 w-[calc(0.5rem+0.75rem+0.125rem)]"
            aria-hidden
          />
        )}
        <button
          type="button"
          onClick={onNavigate}
          aria-label={translate(
            'auto.components.status.bar.ResourceUsageStatusSegment.d659d71d2d',
            'Resume workspace {{value0}}',
            { value0: rowLabel }
          )}
          className="flex-1 min-w-0 py-2 pr-2 pl-1 text-left flex items-center gap-1.5"
          disabled={!isNavigable}
        >
          <span className="text-xs font-medium truncate">{rowLabel}</span>
          {worktree.isRemote && (
            <span className="shrink-0 text-[9px] uppercase tracking-wide text-muted-foreground/70">
              {translate(
                'auto.components.status.bar.ResourceUsageStatusSegment.21cacb16d1',
                '· remote'
              )}
            </span>
          )}
        </button>
        <div className="flex items-center gap-2 shrink-0 pr-3">
          <div className="relative">
            <span
              className={cn(
                'block transition-opacity',
                showWorktreeActions &&
                  'group-hover/wtrow:opacity-0 group-hover/wtrow:pointer-events-none group-focus-within/wtrow:opacity-0 group-focus-within/wtrow:pointer-events-none [@media(hover:none)]:opacity-0 [@media(hover:none)]:pointer-events-none'
              )}
              aria-hidden={showWorktreeActions ? undefined : true}
            >
              <ResourceUsageSparkline samples={worktree.history} />
            </span>
            {showWorktreeActions && (
              <div className="absolute inset-0 flex items-center justify-end gap-0.5 can-hover:opacity-0 can-hover:pointer-events-none transition-opacity group-hover/wtrow:opacity-100 group-hover/wtrow:pointer-events-auto group-focus-within/wtrow:opacity-100 group-focus-within/wtrow:pointer-events-auto">
                <Tooltip delayDuration={300}>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={onDelete}
                      disabled={isMainWorktree}
                      aria-label={translate(
                        'auto.components.status.bar.ResourceUsageStatusSegment.16bc3c998a',
                        'Delete workspace {{value0}}',
                        { value0: rowLabel }
                      )}
                      className={cn(
                        'p-0.5 rounded text-muted-foreground transition-colors',
                        isMainWorktree
                          ? 'opacity-40 cursor-not-allowed'
                          : 'hover:bg-destructive/10 hover:text-destructive'
                      )}
                    >
                      <Trash2 className="size-3" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent
                    side="top"
                    sideOffset={4}
                    className="z-[70] max-w-[200px] text-pretty"
                  >
                    {isMainWorktree
                      ? translate(
                          'auto.components.status.bar.ResourceUsageStatusSegment.946724a70a',
                          'The main workspace cannot be deleted.'
                        )
                      : translate(
                          'auto.components.status.bar.ResourceUsageStatusSegment.a82253b458',
                          'Delete workspace.'
                        )}
                  </TooltipContent>
                </Tooltip>
              </div>
            )}
          </div>
          <ResourceUsageMetricPair cpu={worktree.cpu} memory={worktree.memory} />
          <span className={ROW_TRAILING_GUTTER_CLS} aria-hidden />
        </div>
      </div>
      {!isCollapsed &&
        worktree.sessions.map((session) => (
          <ResourceUsageSessionRow
            key={session.sessionId}
            session={session}
            worktreeId={worktree.worktreeId}
            onNavigate={navigateToTab}
            onKill={onKillSession}
          />
        ))}
      {!isCollapsed &&
        worktree.browsers.map((browser) => <BrowserRow key={browser.id} browser={browser} />)}
    </div>
  )
}
