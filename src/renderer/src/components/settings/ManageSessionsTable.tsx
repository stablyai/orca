import type { PtyManagementSession } from '../../../../preload/api-types'
import { LoaderCircle, RefreshCw, RotateCw, Trash2, X } from 'lucide-react'
import { Button } from '../ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import { formatState, formatWorkspace } from './manage-sessions-format'
import { translate } from '@/i18n/i18n'

type ManageSessionsTableProps = {
  sessions: PtyManagementSession[]
  hasLoadedOnce: boolean
  sessionCount: number
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
  sessions,
  hasLoadedOnce,
  sessionCount,
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
  return (
    <div className="flex flex-col overflow-hidden rounded-lg border border-border/60">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border/60 px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-muted-foreground">
            {translate('auto.components.settings.ManageSessionsSection.a795a9552a', 'Sessions')}
            {hasLoadedOnce ? <span className="ml-1 tabular-nums">({sessionCount})</span> : null}
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
                disabled={isBusy || sessionCount === 0}
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
      ) : sessions.length === 0 ? (
        <div className="flex items-center justify-center px-3 py-8 text-xs text-muted-foreground">
          {translate('auto.components.settings.ManageSessionsSection.e26a60d9eb', 'No sessions.')}
        </div>
      ) : (
        <div className="max-h-[360px] overflow-y-auto scrollbar-sleek">
          <table className="w-full text-xs">
            <tbody>
              {sessions.map((session) => {
                const dotClass = session.isAlive ? 'bg-emerald-500' : 'bg-muted-foreground/40'
                const tabId = ptyIdToTabId.get(session.sessionId) ?? null
                const rowClickable = tabId !== null
                return (
                  <tr
                    key={session.sessionId}
                    className={`border-t border-border/50 first:border-t-0 ${
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
                        aria-label={formatState(session)}
                        title={formatState(session)}
                      />
                    </td>
                    <td className="px-3 py-1.5">
                      <span className="truncate font-mono font-medium">
                        {formatWorkspace(session)}
                      </span>
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
        </div>
      )}
    </div>
  )
}
