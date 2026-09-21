import type { PtyManagementGeneration, PtyManagementSession } from '../../../../preload/api-types'
import { LoaderCircle, RefreshCw, RotateCw, Trash2, X } from 'lucide-react'
import { Button } from '../ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import {
  formatGenerationSessionCount,
  formatState,
  formatVisibleSessionCount,
  formatWorkspace,
  reportedSessions
} from './manage-sessions-format'
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

function GenerationHeader({
  generation
}: {
  generation: PtyManagementGeneration
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-2 bg-muted/40 px-3 py-1.5">
      <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
        {generation.isCurrent
          ? translate('auto.components.settings.ManageSessionsTable.d4ae93e65d', 'Current version')
          : translate(
              'auto.components.settings.ManageSessionsTable.285148ee08',
              'Previous version'
            )}
        <span className="ml-2 font-mono font-normal normal-case tracking-normal">
          {translate(
            'auto.components.settings.ManageSessionsTable.e6ec9241a4',
            'Protocol {{value0}}',
            {
              value0: generation.protocolVersion
            }
          )}
        </span>
      </span>
      <span className="text-[11px] tabular-nums text-muted-foreground">
        {formatGenerationSessionCount(generation)}
      </span>
    </div>
  )
}

function SessionRows({
  sessions,
  isBusy,
  ptyIdToTabId,
  onNavigate,
  onRequestKill
}: Pick<ManageSessionsTableProps, 'isBusy' | 'ptyIdToTabId' | 'onNavigate' | 'onRequestKill'> & {
  sessions: PtyManagementSession[]
}): React.JSX.Element {
  return (
    <table className="w-full text-xs">
      <tbody>
        {sessions.map((session) => {
          const state = formatState(session)
          const dotClass = state === 'running' ? 'bg-status-success' : 'bg-muted-foreground/40'
          const tabId = ptyIdToTabId.get(session.sessionId) ?? null
          const rowClickable = tabId !== null
          return (
            <tr
              key={session.sessionId}
              className={`border-t border-border/50 ${
                rowClickable ? 'cursor-pointer hover:bg-accent/60' : ''
              }`}
              onClick={rowClickable ? () => onNavigate(tabId) : undefined}
              aria-label={
                rowClickable
                  ? translate(
                      'auto.components.settings.ManageSessionsSection.2896a50f50',
                      'Go to terminal {{value0}}',
                      { value0: formatWorkspace(session) }
                    )
                  : undefined
              }
            >
              <td className="px-3 py-1.5">
                <span
                  className={`block size-1.5 rounded-full ${dotClass}`}
                  aria-label={state}
                  title={state}
                />
              </td>
              <td className="px-3 py-1.5">
                <span className="truncate font-mono font-medium">{formatWorkspace(session)}</span>
              </td>
              <td
                className="px-3 py-1.5 font-mono text-[11px] text-muted-foreground"
                title={session.sessionId}
              >
                <span className="block max-w-[280px] truncate">{session.sessionId}</span>
              </td>
              <td className="px-3 py-1.5 text-right">
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={(e) => {
                    e.stopPropagation()
                    onRequestKill(session)
                  }}
                  disabled={isBusy}
                  aria-label={translate(
                    'auto.components.settings.ManageSessionsSection.33c2a1e1b4',
                    'Kill session {{value0}}',
                    { value0: session.sessionId }
                  )}
                  className="text-muted-foreground hover:text-destructive"
                >
                  <X />
                </Button>
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

function GenerationBody(
  props: Pick<
    ManageSessionsTableProps,
    'isBusy' | 'ptyIdToTabId' | 'onNavigate' | 'onRequestKill'
  > & {
    generation: PtyManagementGeneration
  }
): React.JSX.Element {
  const { generation, ...rowProps } = props
  if (generation.contact === 'unverifiable') {
    return (
      <p className="px-3 py-2 text-xs text-muted-foreground" title={generation.detail ?? undefined}>
        {translate(
          'auto.components.settings.ManageSessionsTable.3388ec840f',
          'Orca couldn’t reach this version of the terminal service, so its sessions can’t be listed. They are not known to have stopped.'
        )}
      </p>
    )
  }
  if (generation.sessions.length === 0) {
    return (
      <p className="px-3 py-2 text-xs text-muted-foreground">
        {translate('auto.components.settings.ManageSessionsSection.e26a60d9eb', 'No sessions.')}
      </p>
    )
  }
  return <SessionRows sessions={generation.sessions} {...rowProps} />
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
  const hasUnverifiable = generations.some((generation) => generation.contact !== 'live')
  // Why: one generation is the ordinary case, and a header per group would be noise there.
  // Labels appear exactly when there is another generation to tell it apart from.
  const showGenerationHeaders = generations.length > 1
  return (
    <div className="flex flex-col overflow-hidden rounded-lg border border-border/60">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border/60 px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-muted-foreground">
            {translate('auto.components.settings.ManageSessionsSection.a795a9552a', 'Sessions')}
            {hasLoadedOnce ? (
              <span
                className="ml-1 tabular-nums"
                title={
                  hasUnverifiable
                    ? translate(
                        'auto.components.settings.ManageSessionsTable.2790ddcc1d',
                        'At least {{value0}} — a version Orca couldn’t reach may hold more.',
                        { value0: reportedCount }
                      )
                    : undefined
                }
              >
                ({formatVisibleSessionCount(generations)})
              </span>
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
      ) : generations.length === 0 ? (
        <div className="flex items-center justify-center px-3 py-8 text-xs text-muted-foreground">
          {translate('auto.components.settings.ManageSessionsSection.e26a60d9eb', 'No sessions.')}
        </div>
      ) : (
        <div className="max-h-[360px] overflow-y-auto scrollbar-sleek">
          {generations.map((generation) => (
            <div
              key={generation.protocolVersion}
              className="border-t border-border/60 first:border-t-0"
            >
              {showGenerationHeaders ? <GenerationHeader generation={generation} /> : null}
              <GenerationBody
                generation={generation}
                isBusy={isBusy}
                ptyIdToTabId={ptyIdToTabId}
                onNavigate={onNavigate}
                onRequestKill={onRequestKill}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
