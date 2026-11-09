import { useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { useTranslate, useIntlLocale } from '@/i18n/use-translate'
import { formatUiNarrowRelativeTime } from '@/i18n/relative-time-format'
import { cn } from '@/lib/utils'
import { useMountedRef } from '@/hooks/useMountedRef'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger
} from '@/components/ui/dropdown-menu'
import type { HostRecoveryObservation } from './use-remote-host-menu-state'

export function RemoteHostStatusRow({
  label,
  kind,
  tone,
  status,
  actionLabel,
  actionKind,
  onAction,
  disabled,
  errorSentence,
  rawDetail,
  recovery,
  now,
  onRetry,
  onDisconnect
}: {
  label: string
  kind?: string
  tone: 'connected' | 'offline' | 'busy' | 'error'
  status: string
  actionLabel: string
  actionKind: 'connect' | 'disconnect' | 'recover'
  onAction?: () => Promise<void> | void
  disabled?: boolean
  errorSentence?: string
  rawDetail?: string
  recovery?: HostRecoveryObservation
  now: number
  onRetry?: () => Promise<void>
  onDisconnect?: () => Promise<void>
}): React.JSX.Element {
  const t = useTranslate()
  const locale = useIntlLocale()
  const mounted = useMountedRef()
  const pending = useRef<{ token: symbol; kind: typeof actionKind } | null>(null)
  const [busy, setBusy] = useState<typeof actionKind | null>(null)
  const [open, setOpen] = useState(false)
  const reconnectCard =
    tone === 'busy' && recovery && (recovery.attempt >= 3 || now - recovery.since >= 30_000)
  const hasCard = Boolean(errorSentence || reconnectCard)
  const run = async (action: (() => Promise<void> | void) | undefined, kind: typeof actionKind) => {
    if (!action || pending.current?.kind === kind) {
      return
    }
    const token = Symbol()
    pending.current = { token, kind }
    setBusy(kind)
    try {
      await action()
    } finally {
      if (pending.current?.token === token) {
        pending.current = null
        if (mounted.current) {
          setBusy(null)
        }
      }
    }
  }
  let relativeTime = ''
  if (reconnectCard) {
    const elapsed = Math.max(1000, now - recovery.since)
    const [unit, divisor] =
      elapsed < 60_000
        ? (['second', 1000] as const)
        : elapsed < 3_600_000
          ? (['minute', 60_000] as const)
          : elapsed < 86_400_000
            ? (['hour', 3_600_000] as const)
            : (['day', 86_400_000] as const)
    relativeTime = formatUiNarrowRelativeTime(-Math.floor(elapsed / divisor), unit, locale)
  }
  const rowName = `${label}${kind ? ` ${kind}` : ''}, ${status}`
  const details = (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="flex size-3 shrink-0 items-center justify-center" aria-hidden="true">
            {tone === 'busy' ? (
              <Loader2 className="size-3 animate-spin text-muted-foreground motion-reduce:animate-none" />
            ) : (
              <span
                className={cn(
                  'size-1.5 rounded-full',
                  tone === 'connected'
                    ? 'bg-status-success'
                    : tone === 'error'
                      ? 'bg-destructive'
                      : 'border border-muted-foreground'
                )}
              />
            )}
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={4}>
          {status}
        </TooltipContent>
      </Tooltip>
      <span className="min-w-0 truncate text-xs font-medium">{label}</span>
      {kind ? <span className="shrink-0 text-xs text-muted-foreground">{kind}</span> : null}
    </>
  )
  const action = (
    <DropdownMenuItem
      asChild
      disabled={disabled || busy === actionKind || !onAction}
      onSelect={(event) => {
        event.preventDefault()
        setOpen(false)
        void run(onAction, actionKind)
      }}
    >
      <button
        type="button"
        aria-label={`${actionLabel} ${label}`}
        className={cn(
          'shrink-0 px-1.5 py-0.5 text-2xs text-muted-foreground',
          tone !== 'error' &&
            'can-hover:opacity-0 can-hover:group-hover:opacity-100 can-hover:group-focus-within:opacity-100 can-hover:data-[highlighted]:opacity-100'
        )}
      >
        {actionLabel}
      </button>
    </DropdownMenuItem>
  )
  const triggerClass = 'min-w-0 flex-1'
  return (
    <div className="group flex items-center rounded-md hover:bg-accent focus-within:bg-accent">
      {hasCard ? (
        <DropdownMenuSub open={open} onOpenChange={setOpen}>
          <DropdownMenuSubTrigger className={triggerClass} hideChevron aria-label={rowName}>
            {details}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-[min(18rem,calc(100vw-1rem))] p-1.5">
            <p className="px-1.5 py-1 text-xs text-muted-foreground">
              {errorSentence ??
                t(
                  'auto.components.status.bar.RemoteHostStatusRow.unreachable_since',
                  "Can't reach this host since {{time}}.",
                  { time: relativeTime }
                )}
            </p>
            {errorSentence ? (
              <DropdownMenuItem
                disabled={!rawDetail}
                onSelect={(event) => {
                  event.preventDefault()
                  if (rawDetail) {
                    void window.api.ui.writeClipboardText(rawDetail)
                  }
                }}
              >
                {t('auto.components.status.bar.RemoteHostStatusRow.copy_error', 'Copy error')}
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem
                disabled={busy === 'connect'}
                onSelect={(event) => {
                  event.preventDefault()
                  void run(onRetry, 'connect')
                }}
              >
                {t('auto.components.status.bar.RemoteHostStatusRow.retry_now', 'Retry now')}
              </DropdownMenuItem>
            )}
            <DropdownMenuItem
              variant="destructive"
              disabled={busy === 'disconnect'}
              onSelect={(event) => {
                event.preventDefault()
                void run(onDisconnect, 'disconnect')
              }}
            >
              {reconnectCard && !errorSentence
                ? t(
                    'auto.components.status.bar.RemoteHostStatusRow.stop_reconnecting',
                    'Stop reconnecting'
                  )
                : t('auto.components.status.bar.SshStatusSegment.59b553e2aa', 'Disconnect')}
            </DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      ) : (
        <DropdownMenuItem
          className={triggerClass}
          aria-label={rowName}
          onSelect={(event) => event.preventDefault()}
        >
          {details}
        </DropdownMenuItem>
      )}
      {action}
    </div>
  )
}
