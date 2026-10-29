import { Loader2 } from 'lucide-react'
import type { RuntimeAccessGrant } from '../../../../shared/runtime-access-grants'
import { Button } from '../ui/button'
import { getIntlLocale, translate } from '@/i18n/i18n'

function formatAccessTimestamp(timestamp: number): string {
  return new Intl.DateTimeFormat(getIntlLocale(), {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  }).format(new Date(timestamp))
}

// Why: main names each link "Runtime <date>"; show it as a link, not a runtime.
function grantDisplayName(grant: RuntimeAccessGrant): string {
  return /^Runtime \d/.test(grant.name)
    ? translate('auto.components.settings.RuntimeAccessGrantList.linkName', 'Link · {{value0}}', {
        value0: new Intl.DateTimeFormat(getIntlLocale(), { month: 'short', day: 'numeric' }).format(
          new Date(grant.createdAt)
        )
      })
    : grant.name
}

type RuntimeAccessGrantListProps = {
  className?: string
  grants: RuntimeAccessGrant[]
  currentGrantId: string | null
  isLoading: boolean
  revokingGrantId: string | null
  onRevoke: (grant: RuntimeAccessGrant) => void
}

export function RuntimeAccessGrantList({
  className,
  grants,
  currentGrantId,
  isLoading,
  revokingGrantId,
  onRevoke
}: RuntimeAccessGrantListProps): React.JSX.Element {
  return (
    <div className={className}>
      <div className="mb-2 flex items-center justify-between gap-3">
        <h3 className="text-sm font-medium">
          {translate('auto.components.settings.RuntimeAccessGrantList.activeLinks', 'Active links')}
        </h3>
      </div>

      {grants.length === 0 && isLoading ? null : grants.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          {translate(
            'auto.components.settings.RuntimeAccessGrantList.noActiveLinks',
            'No active links.'
          )}
        </p>
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
                    <span className="truncate text-sm font-medium">{grantDisplayName(grant)}</span>
                    {isCurrent ? (
                      <span className="text-muted-foreground shrink-0 text-xs">
                        {translate(
                          'auto.components.settings.RuntimeAccessGrantList.434e4a6af6',
                          'Current link'
                        )}
                      </span>
                    ) : null}
                  </div>
                  <div className="text-muted-foreground text-xs">
                    {translate(
                      'auto.components.settings.RuntimeAccessGrantList.createdAt',
                      'Created {{value0}}',
                      { value0: formatAccessTimestamp(grant.createdAt) }
                    )}
                    {' · '}
                    {grant.lastSeenAt
                      ? translate(
                          'auto.components.settings.RuntimeAccessGrantList.b18d1764ef',
                          'Last used {{value0}}',
                          { value0: formatAccessTimestamp(grant.lastSeenAt) }
                        )
                      : translate(
                          'auto.components.settings.RuntimeAccessGrantList.df142657a5',
                          'Not used yet'
                        )}
                  </div>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  onClick={() => onRevoke(grant)}
                  disabled={isRevoking}
                  aria-label={translate(
                    'auto.components.settings.RuntimeAccessGrantList.6f6d5188ed',
                    'Revoke {{value0}}',
                    { value0: grantDisplayName(grant) }
                  )}
                >
                  {isRevoking ? <Loader2 className="animate-spin" /> : null}
                  {translate('auto.components.settings.RuntimeAccessGrantList.revoke', 'Revoke')}
                </Button>
              </div>
            )
          })}
        </div>
      )}
      {grants.length > 0 ? (
        <p className="text-muted-foreground mt-3 text-xs">
          {translate(
            'auto.components.settings.RuntimeAccessGrantList.sshAccessCaveat',
            "Revoking here doesn't stop someone with SSH access to this computer from pairing again. To cut them off, remove their SSH access."
          )}
        </p>
      ) : null}
    </div>
  )
}
