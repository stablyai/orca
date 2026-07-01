import React from 'react'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type { DbConnectionStatus } from '../../../../shared/database-types'

// Maps a live connection status to a dot color. `lost` and `error` read as
// destructive; `connected` as success; transitional states pulse amber.
// Why: the destructive class is hoisted to a const so the `error`/`lost` values
// are identifiers, not string literals under the localization-audited `error` key.
const DESTRUCTIVE_DOT = 'bg-destructive'
const STATUS_DOT: Record<DbConnectionStatus, string> = {
  idle: 'bg-muted-foreground/40',
  testing: 'bg-amber-500 animate-pulse',
  connecting: 'bg-amber-500 animate-pulse',
  connected: 'bg-emerald-500',
  error: DESTRUCTIVE_DOT,
  lost: DESTRUCTIVE_DOT
}

export function statusLabel(status: DbConnectionStatus): string {
  switch (status) {
    case 'idle':
      return translate('auto.components.database.status.idle', 'Not connected')
    case 'testing':
      return translate('auto.components.database.status.testing', 'Testing…')
    case 'connecting':
      return translate('auto.components.database.status.connecting', 'Connecting…')
    case 'connected':
      return translate('auto.components.database.status.connected', 'Connected')
    case 'error':
      return translate('auto.components.database.status.error', 'Error')
    case 'lost':
      return translate('auto.components.database.status.lost', 'Connection lost')
  }
}

// Connected/idle read clearly from the dot plus the connect/disconnect button, so
// only mid-flight and failed states earn a visible text label next to the name.
export function isNoteworthyStatus(status: DbConnectionStatus): boolean {
  return status !== 'connected' && status !== 'idle'
}

export function statusTextClass(status: DbConnectionStatus): string {
  return status === 'error' || status === 'lost' ? 'text-destructive' : 'text-muted-foreground'
}

export function ConnectionStatusDot({
  status,
  className
}: {
  status: DbConnectionStatus
  className?: string
}): React.JSX.Element {
  return (
    <span
      className={cn('size-1.5 shrink-0 rounded-full', STATUS_DOT[status], className)}
      aria-hidden="true"
    />
  )
}
