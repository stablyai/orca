import { Loader2, RefreshCw, Trash2 } from 'lucide-react'
import type { RuntimeAccessGrant } from '../../../../shared/runtime-access-grants'
import { Button } from '../ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import { translate } from '@/i18n/i18n'

function formatAccessTimestamp(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  }).format(new Date(timestamp))
}

type RuntimeAccessGrantListProps = {
  className?: string
  grants: RuntimeAccessGrant[]
  currentGrantId: string | null
  isLoading: boolean
  revokingGrantId: string | null
  onRefresh: () => void
  onRevoke: (grant: RuntimeAccessGrant) => void
}

export function RuntimeAccessGrantList({
  className,
  grants,
  currentGrantId,
  isLoading,
  revokingGrantId,
  onRefresh,
  onRevoke
}: RuntimeAccessGrantListProps): React.JSX.Element {
  return (
    <div className={className}>
      <div className="mb-2 flex items-center justify-between gap-3">
        <h3 className="text-sm font-medium">{translate("auto.components.settings.RuntimeAccessGrantList.f031182867", "Shared Server Access")}</h3>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              onClick={onRefresh}
              disabled={isLoading}
              aria-label={translate("auto.components.settings.RuntimeAccessGrantList.27cf8507ad", "Refresh shared access")}
            >
              <RefreshCw className={isLoading ? 'animate-spin' : undefined} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}>
            {translate("auto.components.settings.RuntimeAccessGrantList.27cf8507ad", "Refresh shared access")}</TooltipContent>
        </Tooltip>
      </div>

      {grants.length === 0 ? (
        <p className="text-muted-foreground text-sm">{translate("auto.components.settings.RuntimeAccessGrantList.fd83b94095", "No shared server access yet.")}</p>
      ) : (
        <div className="space-y-2">
          {grants.map((grant) => {
            const isCurrent = currentGrantId === grant.deviceId
            const isRevoking = revokingGrantId === grant.deviceId
            return (
              <div
                key={grant.deviceId}
                className="flex min-w-0 items-center justify-between gap-3 rounded-lg border border-border/60 px-3 py-2"
              >
                <div className="min-w-0 space-y-0.5">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-sm font-medium">{grant.name}</span>
                    {isCurrent ? (
                      <span className="text-muted-foreground shrink-0 text-xs">{translate("auto.components.settings.RuntimeAccessGrantList.434e4a6af6", "Current link")}</span>
                    ) : null}
                  </div>
                  <div className="text-muted-foreground text-xs">
                    {translate("auto.components.settings.RuntimeAccessGrantList.87b16cd11d", "Created")}{formatAccessTimestamp(grant.createdAt)} ·{' '}
                    {grant.lastSeenAt
                      ? translate("auto.components.settings.RuntimeAccessGrantList.b18d1764ef", "Last used {{value0}}", { value0: formatAccessTimestamp(grant.lastSeenAt) })
                      : translate("auto.components.settings.RuntimeAccessGrantList.df142657a5", "Not used yet")}
                  </div>
                </div>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="text-destructive hover:text-destructive shrink-0"
                      onClick={() => onRevoke(grant)}
                      disabled={isRevoking}
                      aria-label={translate("auto.components.settings.RuntimeAccessGrantList.6f6d5188ed", "Revoke {{value0}}", { value0: grant.name })}
                    >
                      {isRevoking ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <Trash2 className="size-3.5" />
                      )}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="top" sideOffset={4}>
                    {translate("auto.components.settings.RuntimeAccessGrantList.68ec21309f", "Revoke access")}</TooltipContent>
                </Tooltip>
              </div>
            )
          })}
        </div>
      )}
      {grants.length > 0 ? (
        <p className="text-muted-foreground mt-3 text-xs">
          {translate("auto.components.settings.RuntimeAccessGrantList.8b82879581", "Anyone with an active grant can connect until you revoke it. Revoking shared access disconnects active clients immediately.")}</p>
      ) : null}
    </div>
  )
}
