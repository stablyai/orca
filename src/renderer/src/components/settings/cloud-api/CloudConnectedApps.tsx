import { useState } from 'react'
import { Plug, ShieldCheck, Unplug } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useIntlLocale, useTranslate, type Translate } from '@/i18n/use-translate'
import type { CloudApiGrant, CloudApiMe } from '../../../../../shared/cloud-api/cloud-api-types'
import { SettingsGroup } from '../section-layout/SettingsGroup'
import { CloudConfirmDialog } from './CloudConfirmDialog'
import { formatAbsoluteTime, formatKeyPrefix, formatRelativeFromNow } from './cloud-api-format'
import {
  CloudApiEmptyState,
  CloudApiErrorNotice,
  CloudApiSkeletonRows,
  ScopeChip
} from './cloud-api-parts'
import type { CloudLoadState } from './cloud-load-state'

function appName(grant: CloudApiGrant, t: Translate): string {
  return (
    grant.clientName?.trim() ||
    grant.clientId ||
    t('auto.components.settings.cloudApi.apps.unnamed', 'Unnamed app')
  )
}

/** MCP clients approved against this account; disconnecting revokes every token of the grant. */
export function CloudConnectedApps({
  grants,
  viewer,
  now,
  onApprove,
  onRevoke,
  onRetry,
  initialRevokeId
}: {
  grants: CloudLoadState<CloudApiGrant[]>
  viewer: CloudApiMe | null
  now: number
  onApprove: () => void
  onRevoke: (grant: CloudApiGrant) => Promise<string | null>
  onRetry: () => void
  initialRevokeId?: string
}): React.JSX.Element | null {
  const t = useTranslate()
  const locale = useIntlLocale()
  const [target, setTarget] = useState<CloudApiGrant | null>(() =>
    grants.status === 'ok'
      ? (grants.data.find((grant) => grant.id === initialRevokeId) ?? null)
      : null
  )
  const [confirmOpen, setConfirmOpen] = useState(target !== null)

  // Older control planes have no MCP server: say nothing rather than show an error.
  if (grants.status === 'error' && grants.code === 'not-available') {
    return null
  }

  return (
    <>
      <SettingsGroup
        title={t('auto.components.settings.cloudApi.apps.title', 'Connected apps')}
        description={
          viewer?.orgId && viewer.role !== 'member'
            ? t(
                'auto.components.settings.cloudApi.apps.descriptionAdmin',
                'MCP clients anyone in your org approved. A connection lasts 90 days, or until you disconnect it or revoke the key that approved it.'
              )
            : t(
                'auto.components.settings.cloudApi.apps.description',
                'MCP clients you approved. A connection lasts 90 days, or until you disconnect it or revoke the key that approved it.'
              )
        }
      >
        {grants.status === 'loading' ? (
          <CloudApiSkeletonRows
            rows={1}
            label={t('auto.components.settings.cloudApi.apps.loading', 'Loading connected apps')}
          />
        ) : grants.status === 'error' ? (
          <div data-settings-row="" className="py-4">
            <CloudApiErrorNotice message={grants.message} onRetry={onRetry} />
          </div>
        ) : grants.data.length === 0 ? (
          <CloudApiEmptyState
            icon={Plug}
            title={t('auto.components.settings.cloudApi.apps.emptyTitle', 'No apps connected')}
            description={t(
              'auto.components.settings.cloudApi.apps.emptyBody',
              'Add the MCP server URL to Claude, Cursor or another client. When it asks you to approve, use a one-time code.'
            )}
            action={
              <Button type="button" variant="outline" size="sm" onClick={onApprove}>
                <ShieldCheck />
                {t('auto.components.settings.cloudApi.links.approve', 'Approve app')}
              </Button>
            }
          />
        ) : (
          <ul aria-label={t('auto.components.settings.cloudApi.apps.listLabel', 'Connected apps')}>
            {grants.data.map((grant) => (
              <li key={grant.id} data-settings-row="" className="flex items-start gap-3 py-3.5">
                <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md border border-border/70 bg-muted/40 text-muted-foreground">
                  <Plug className="size-3.5" aria-hidden />
                </div>
                <div className="min-w-0 flex-1 space-y-1.5">
                  <p className="truncate text-sm font-medium">{appName(grant, t)}</p>
                  <div className="flex flex-wrap gap-1">
                    {grant.scopes.map((scope) => (
                      <ScopeChip key={scope} scope={scope} />
                    ))}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    <span title={formatAbsoluteTime(grant.grantedAt, locale)}>
                      {'apiKeyPrefix' in grant.approvedWith
                        ? t(
                            'auto.components.settings.cloudApi.apps.viaKey',
                            'Approved {{value0}} with {{value1}}',
                            {
                              value0: formatRelativeFromNow(grant.grantedAt, now, locale),
                              value1: formatKeyPrefix(grant.approvedWith.apiKeyPrefix)
                            }
                          )
                        : t(
                            'auto.components.settings.cloudApi.apps.viaCode',
                            'Approved {{value0}} with a one-time code',
                            { value0: formatRelativeFromNow(grant.grantedAt, now, locale) }
                          )}
                      {viewer && grant.userId !== viewer.userId
                        ? ` ${t('auto.components.settings.cloudApi.apps.byTeammate', 'by a teammate')}`
                        : null}
                    </span>
                    <span aria-hidden> · </span>
                    {grant.lastUsedAt
                      ? t(
                          'auto.components.settings.cloudApi.keys.lastUsed',
                          'Last used {{value0}}',
                          {
                            value0: formatRelativeFromNow(grant.lastUsedAt, now, locale)
                          }
                        )
                      : t('auto.components.settings.cloudApi.keys.neverUsed', 'Never used')}
                    {grant.expiresAt ? (
                      <>
                        <span aria-hidden> · </span>
                        <span title={formatAbsoluteTime(grant.expiresAt, locale)}>
                          {t(
                            'auto.components.settings.cloudApi.keys.expires',
                            'Expires {{value0}}',
                            {
                              value0: formatRelativeFromNow(grant.expiresAt, now, locale)
                            }
                          )}
                        </span>
                      </>
                    ) : null}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  aria-label={t(
                    'auto.components.settings.cloudApi.apps.disconnectLabel',
                    'Disconnect {{value0}}',
                    {
                      value0: appName(grant, t)
                    }
                  )}
                  onClick={() => {
                    setTarget(grant)
                    setConfirmOpen(true)
                  }}
                >
                  <Unplug />
                  {t('auto.components.settings.cloudApi.apps.disconnect', 'Disconnect')}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </SettingsGroup>
      <CloudConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={t('auto.components.settings.cloudApi.apps.confirmTitle', 'Disconnect {{value0}}?', {
          value0: target ? appName(target, t) : ''
        })}
        description={
          <p>
            {t(
              'auto.components.settings.cloudApi.apps.confirmBody',
              'It loses access to Orca Cloud right away. To use it again, approve it again from the app.'
            )}
          </p>
        }
        confirmLabel={t('auto.components.settings.cloudApi.apps.confirm', 'Disconnect')}
        onConfirm={async () => (target ? onRevoke(target) : null)}
      />
    </>
  )
}
