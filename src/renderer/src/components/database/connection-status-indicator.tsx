import React from 'react'
import { Badge } from '@/components/ui/badge'
import { translate } from '@/i18n/i18n'
import type { DbConnectionStatus } from '../../../../shared/database-types'

// Maps a live connection status to a dot color + label. `lost` and `error` read
// as destructive; `connected` as success; transitional states are muted.
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

function statusLabel(status: DbConnectionStatus): string {
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

export function ConnectionStatusIndicator({
  status
}: {
  status: DbConnectionStatus
}): React.JSX.Element {
  return (
    <Badge variant="outline" className="h-5 gap-1.5 text-[10px] font-normal">
      <span className={`size-1.5 rounded-full ${STATUS_DOT[status]}`} aria-hidden="true" />
      {statusLabel(status)}
    </Badge>
  )
}
