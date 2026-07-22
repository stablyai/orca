import { CheckCircle2, CircleAlert } from 'lucide-react'
import type React from 'react'

export function MobileEmulatorToolchainRow({
  ready,
  title,
  detail,
  actions,
  error
}: {
  ready: boolean
  title: string
  detail: React.ReactNode
  actions?: React.ReactNode
  error?: string | null
}): React.JSX.Element {
  const Icon = ready ? CheckCircle2 : CircleAlert
  return (
    <div className="flex items-start gap-3 py-3">
      <Icon
        className={
          ready
            ? 'mt-0.5 size-4 shrink-0 text-status-success'
            : 'mt-0.5 size-4 shrink-0 text-muted-foreground'
        }
      />
      <div className="min-w-0 flex-1 space-y-2">
        <div className="space-y-0.5">
          <div className="text-sm font-medium text-foreground">{title}</div>
          <div className="break-words text-xs text-muted-foreground">{detail}</div>
          {error ? <div className="text-xs text-destructive">{error}</div> : null}
        </div>
        {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
      </div>
    </div>
  )
}
