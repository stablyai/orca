import React from 'react'
import { AlertCircle } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'

export type KanbanErrorBannerProps =
  | { kind: 'network'; message: string; onRetry: () => void }
  | { kind: 'auth'; onReconnect: () => void }

export function KanbanErrorBanner(props: KanbanErrorBannerProps): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border bg-destructive/10 px-4 py-3 text-sm text-destructive">
      <AlertCircle className="size-4 flex-none" />
      <span className="min-w-0 flex-1">
        {props.kind === 'network'
          ? props.message
          : translate(
              'auto.components.kanban.error.auth',
              'Kanban authentication failed. Reconnect your token to continue.'
            )}
      </span>
      <Button
        variant="outline"
        size="sm"
        onClick={props.kind === 'network' ? props.onRetry : props.onReconnect}
      >
        {props.kind === 'network'
          ? translate('auto.components.kanban.error.retry', 'Retry')
          : translate('auto.components.kanban.error.reconnect', 'Reconnect')}
      </Button>
    </div>
  )
}
