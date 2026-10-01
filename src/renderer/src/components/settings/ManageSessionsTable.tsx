import type { PtyManagementGeneration, PtyManagementSession } from '../../../../preload/api-types'
import { LoaderCircle, RefreshCw, RotateCw, Trash2 } from 'lucide-react'
import { Button } from '../ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import {
  formatVisibleSessionCount,
  reportedSessions,
  visibleGenerations
} from './manage-sessions-format'
import { GenerationRows } from './ManageSessionsGenerationRows'
import { translate } from '@/i18n/i18n'

type ManageSessionsTableProps = {
  generations: PtyManagementGeneration[]
  hasLoadedOnce: boolean
  isBusy: boolean
  isRefreshing: boolean
  daemonBusyKind: 'killAll' | 'restart' | null
  ptyIdToTabId: Map<string, string>
  onRefresh: () => void
  onKillAll: () => void
  onRestartDaemon: () => void
  onNavigate: (tabId: string) => void
  onRequestKill: (session: PtyManagementSession) => void
}

export function ManageSessionsTable({
  generations,
  hasLoadedOnce,
  isBusy,
  isRefreshing,
  daemonBusyKind,
  ptyIdToTabId,
  onRefresh,
  onKillAll,
  onRestartDaemon,
  onNavigate,
  onRequestKill
}: ManageSessionsTableProps): React.JSX.Element {
  const reportedCount = reportedSessions(generations).length
  const hasUnverifiable = generations.some((generation) => generation.contact === 'unverifiable')
  const shown = visibleGenerations(generations)
  const visibleCount = formatVisibleSessionCount(generations)
  // Why: one generation is the ordinary case, and a header per group would be noise there.
  const showGenerationHeaders = shown.length > 1
  return (
    <div className="flex flex-col overflow-hidden rounded-lg border border-border/60">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border/60 px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-muted-foreground">
            {translate('auto.components.settings.ManageSessionsSection.a795a9552a', 'Sessions')}
            {hasLoadedOnce && visibleCount !== null ? (
              <span className="ml-1 tabular-nums">({visibleCount})</span>
            ) : null}
          </span>
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={() => void onRefresh()}
            disabled={isBusy || isRefreshing}
            aria-label={translate(
              'auto.components.settings.ManageSessionsSection.b3b1cc5708',
              'Refresh'
            )}
            className="text-muted-foreground"
          >
            <RefreshCw className={isRefreshing ? 'animate-spin' : ''} />
          </Button>
        </div>
        <div className="flex items-center gap-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                disabled={isBusy || reportedCount === 0}
                onClick={onKillAll}
                aria-label={translate(
                  'auto.components.settings.ManageSessionsSection.3282db098c',
                  'Kill all sessions'
                )}
                className="text-muted-foreground hover:text-destructive"
              >
                {daemonBusyKind === 'killAll' ? (
                  <LoaderCircle className="animate-spin" />
                ) : (
                  <Trash2 />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              {translate(
                'auto.components.settings.ManageSessionsSection.3282db098c',
                'Kill all sessions'
              )}
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                disabled={isBusy}
                onClick={onRestartDaemon}
                aria-label={translate(
                  'auto.components.settings.ManageSessionsSection.5ed15e778c',
                  'Restart daemon'
                )}
                className="text-muted-foreground"
              >
                {daemonBusyKind === 'restart' ? (
                  <LoaderCircle className="animate-spin" />
                ) : (
                  <RotateCw />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              {translate(
                'auto.components.settings.ManageSessionsSection.5ed15e778c',
                'Restart daemon'
              )}
            </TooltipContent>
          </Tooltip>
        </div>
      </div>

      {!hasLoadedOnce ? (
        <div className="flex items-center justify-center px-3 py-8 text-xs text-muted-foreground">
          {translate('auto.components.settings.ManageSessionsSection.39c53d6d74', 'Loading…')}
        </div>
      ) : reportedCount === 0 && !hasUnverifiable ? (
        <div className="flex items-center justify-center px-3 py-8 text-xs text-muted-foreground">
          {translate('auto.components.settings.ManageSessionsSection.e26a60d9eb', 'No sessions.')}
        </div>
      ) : (
        <div className="max-h-[360px] overflow-y-auto scrollbar-sleek">
          <table className="w-full text-xs">
            {shown.map((generation, index) => (
              <GenerationRows
                key={generation.protocolVersion}
                generation={generation}
                showHeader={showGenerationHeaders}
                isFirstGroup={index === 0}
                isBusy={isBusy}
                ptyIdToTabId={ptyIdToTabId}
                onNavigate={onNavigate}
                onRequestKill={onRequestKill}
              />
            ))}
          </table>
          {hasUnverifiable && reportedCount > 0 ? (
            <p className="border-t border-border/50 px-3 py-2 text-[11px] text-muted-foreground">
              {translate(
                'auto.components.settings.ManageSessionsTable.2790ddcc1d',
                '{{value0}} listed — a version Orca couldn’t reach may hold more sessions.',
                { value0: reportedCount }
              )}
            </p>
          ) : null}
        </div>
      )}
    </div>
  )
}
