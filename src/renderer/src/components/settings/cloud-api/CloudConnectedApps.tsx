import { useRef, useState } from 'react'
import { Plug, ShieldCheck, Unplug } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useIntlLocale, useTranslate, type Translate } from '@/i18n/use-translate'
import type { CloudApiGrant, CloudApiMe } from '../../../../../shared/cloud-api/cloud-api-types'
import { SettingsGroup } from '../section-layout/SettingsGroup'
import { CloudConfirmDialog } from './CloudConfirmDialog'
import {
  formatAbsoluteTime,
  formatKeyPrefix,
  formatRelativeFromNow,
  formatList
} from './cloud-api-format'
import { CloudApiEmptyState, CloudApiErrorNotice, CloudApiSkeletonRows } from './cloud-api-parts'
import { PersonSentence } from './PersonName'
import { ScopeSummary } from './ScopeSummary'
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
  const listRef = useRef<HTMLUListElement>(null)
  const groupRef = useRef<HTMLDivElement>(null)
  const targetIndex = useRef(0)

  // Older control planes have no MCP server: say nothing rather than show an error.
  if (grants.status === 'error' && grants.code === 'not-available') {
    return null
  }

  return (
    <div ref={groupRef}>
      <SettingsGroup
        title={t('auto.components.settings.cloudApi.apps.title', 'Connected apps')}
        description={
          viewer?.orgId && viewer.role !== 'member'
            ? t(
                'auto.components.settings.cloudApi.apps.descriptionAdmin',
                'MCP clients anyone on your team approved. A connection lasts 90 days, or until you disconnect it or revoke the key that approved it.'
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
          <ul
            ref={listRef}
            aria-label={t('auto.components.settings.cloudApi.apps.listLabel', 'Connected apps')}
          >
            {grants.data.map((grant, index) => (
              <li
                key={grant.id}
                data-grant-id={grant.id}
                data-settings-row=""
                className="flex items-start gap-3 py-3"
              >
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex min-w-0 items-baseline gap-2">
                    <p className="truncate text-sm font-medium" title={appName(grant, t)}>
                      {appName(grant, t)}
                    </p>
                    {grant.redirectHosts?.length ? (
                      <code
                        className="truncate font-mono text-xs text-muted-foreground"
                        title={formatList(grant.redirectHosts)}
                      >
                        {formatList(grant.redirectHosts)}
                      </code>
                    ) : null}
                    <ScopeSummary scopes={grant.scopes} />
                  </div>
                  <p className="text-xs text-muted-foreground">
                    <span title={formatAbsoluteTime(grant.grantedAt, locale)}>
                      {'apiKeyPrefix' in grant.approvedWith
                        ? t(
                            'auto.components.settings.cloudApi.apps.viaKey',
                            'Approved {{time}} with {{keyPrefix}}',
                            {
                              time: formatRelativeFromNow(grant.grantedAt, now, locale),
                              keyPrefix: formatKeyPrefix(grant.approvedWith.apiKeyPrefix)
                            }
                          )
                        : t(
                            'auto.components.settings.cloudApi.apps.viaCode',
                            'Approved {{time}} with a one-time code',
                            { time: formatRelativeFromNow(grant.grantedAt, now, locale) }
                          )}
                    </span>
                    {viewer && grant.userId !== viewer.userId ? (
                      <>
                        <span aria-hidden> · </span>
                        <PersonSentence
                          sentence={t(
                            'auto.components.settings.cloudApi.apps.approvedBy',
                            'Approved by <person></person>'
                          )}
                          name={grant.userName}
                          id={grant.userId}
                        />
                      </>
                    ) : null}
                    <span aria-hidden> · </span>
                    {grant.lastUsedAt
                      ? t('auto.components.settings.cloudApi.keys.lastUsed', 'Last used {{time}}', {
                          time: formatRelativeFromNow(grant.lastUsedAt, now, locale)
                        })
                      : t('auto.components.settings.cloudApi.keys.neverUsed', 'Never used')}
                    {grant.expiresAt ? (
                      <>
                        <span aria-hidden> · </span>
                        <span title={formatAbsoluteTime(grant.expiresAt, locale)}>
                          {t('auto.components.settings.cloudApi.keys.expires', 'Expires {{time}}', {
                            time: formatRelativeFromNow(grant.expiresAt, now, locale)
                          })}
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
                    'Disconnect {{appName}}',
                    {
                      appName: appName(grant, t)
                    }
                  )}
                  data-disconnect=""
                  onClick={() => {
                    targetIndex.current = index
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
        title={t('auto.components.settings.cloudApi.apps.confirmTitle', 'Disconnect {{appName}}?', {
          appName: target ? appName(target, t) : ''
        })}
        description={
          <>
            <p>
              {t(
                'auto.components.settings.cloudApi.apps.confirmBody',
                'It loses access to Orca Cloud right away. To use it again, approve it again from the app.'
              )}
            </p>
            {target?.redirectHosts?.length ? (
              <p>
                {t(
                  'auto.components.settings.cloudApi.apps.confirmHosts',
                  'It signs in through {{hosts}}.',
                  {
                    hosts: formatList(target.redirectHosts)
                  }
                )}
              </p>
            ) : null}
          </>
        }
        confirmLabel={t('auto.components.settings.cloudApi.apps.confirm', 'Disconnect')}
        returnFocusTo={() => {
          if (
            !target ||
            listRef.current?.querySelector(`[data-grant-id="${CSS.escape(target.id)}"]`)
          ) {
            return null
          }
          const rows = [
            ...(listRef.current?.querySelectorAll<HTMLElement>('[data-grant-id]') ?? [])
          ]
          const next = rows[targetIndex.current] ?? rows[targetIndex.current - 1]
          return (
            next?.querySelector<HTMLElement>('button[data-disconnect]') ??
            groupRef.current?.querySelector<HTMLElement>('button') ??
            null
          )
        }}
        onConfirm={async () => (target ? onRevoke(target) : null)}
      />
    </div>
  )
}
