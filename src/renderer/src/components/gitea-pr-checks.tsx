import { CheckCircle2, CircleAlert, CircleDot, CircleX, ExternalLink } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { GiteaPRCheck } from '../../../shared/types'
import { translate } from '@/i18n/i18n'

function stateIcon(state: GiteaPRCheck['state']): React.JSX.Element {
  switch (state) {
    case 'success':
      return <CheckCircle2 className="size-4 text-status-success" />
    case 'failure':
    case 'error':
      return <CircleX className="size-4 text-destructive" />
    case 'warning':
      return <CircleAlert className="size-4 text-status-warning" />
    case 'pending':
      return <CircleDot className="size-4 text-muted-foreground" />
  }
}

export function GiteaPrChecks({ checks }: { checks: GiteaPRCheck[] }): React.JSX.Element {
  if (checks.length === 0) {
    return (
      <p className="px-4 py-6 text-sm text-muted-foreground">
        {translate(
          'auto.components.gitea.pr.checks.bed82a55cd',
          'No status checks reported for this PR.'
        )}
      </p>
    )
  }
  return (
    <div className="flex flex-col gap-1 px-3 py-3">
      {checks.map((check, index) => (
        <div
          key={`${check.context}:${index}`}
          className="flex items-center gap-2 rounded-md border border-border/50 bg-background/60 px-3 py-2"
        >
          <span className="shrink-0">{stateIcon(check.state)}</span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm text-foreground">{check.context}</span>
            {check.description ? (
              <span className="block truncate text-xs text-muted-foreground">
                {check.description}
              </span>
            ) : null}
          </span>
          <span className={cn('shrink-0 text-[11px] text-muted-foreground')}>{check.state}</span>
          {check.targetUrl ? (
            <button
              type="button"
              onClick={() => check.targetUrl && window.api.shell.openUrl(check.targetUrl)}
              aria-label={translate(
                'auto.components.gitea.pr.checks.448c6113a4',
                'Open check details'
              )}
              className="shrink-0 rounded p-1 text-muted-foreground/60 transition-colors hover:text-foreground"
            >
              <ExternalLink className="size-3.5" />
            </button>
          ) : null}
        </div>
      ))}
    </div>
  )
}
