// A bot or group header's second line: on a paired server it starts with that server, then the status.
import { Server } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import type { ExecutionHostId } from '../../../../shared/execution-host/execution-host'
import { useBotHostLabel } from './use-bot-host-label'

const LINE = 'text-xs leading-4 text-muted-foreground'

/**
 * `children(compact)` is the status; `compact` asks for its short form, which the host's name makes room
 * for. A down server's line says so instead of a stale status. This computer's bots keep today's line.
 */
export function BotPanelHostLine({
  hostId,
  offline,
  title,
  children
}: {
  hostId: ExecutionHostId
  offline: boolean
  title?: string
  children: (compact: boolean) => React.ReactNode
}): React.JSX.Element {
  const t = useTranslate()
  const host = useBotHostLabel(hostId)
  if (!host) {
    return (
      <div className={`truncate ${LINE}`} title={title}>
        {children(false)}
      </div>
    )
  }
  const runsOn = t('bots.panel.runsOn', 'Runs on {{host}}', { host })
  const status = offline ? t('bots.panel.disconnected', 'Disconnected') : children(true)
  return (
    <div className={`@container/host-line flex min-w-0 items-center gap-1 ${LINE}`}>
      {/* The host gives way before the status; on a line too short for both, only its icon stays. */}
      <span className="flex min-w-0 max-w-[40%] items-center gap-1" title={runsOn}>
        <Server className="size-3 shrink-0 text-muted-foreground/70" aria-hidden />
        {/* With no status beside it, the name stays and truncates instead. */}
        <span
          className={status == null ? 'truncate' : 'truncate @max-[10rem]/host-line:hidden'}
          aria-hidden
        >
          {host}
        </span>
        <span className="sr-only">{runsOn}</span>
      </span>
      {status == null ? null : (
        <>
          <span className="@max-[10rem]/host-line:hidden" aria-hidden>
            ·
          </span>
          <span className="min-w-0 flex-1 truncate" title={offline ? undefined : title}>
            {status}
          </span>
        </>
      )}
    </div>
  )
}
