import { Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import type { CloudApiKey, CloudApiMe } from '../../../../../shared/cloud-api/cloud-api-types'
import { formatAbsoluteTime, formatKeyPrefix, formatRelativeFromNow } from './cloud-api-format'
import { PersonSentence } from './PersonName'
import { ScopeSummary } from './ScopeSummary'

const EXPIRY_WARNING_MS = 7 * 86_400_000

/** One Orca API key: name, masked prefix, permission badge, who made it and when it was used. */
export function KeyRow({
  apiKey,
  viewer,
  now,
  onRevoke
}: {
  apiKey: CloudApiKey
  viewer: CloudApiMe | null
  now: number
  onRevoke: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const locale = useIntlLocale()
  const mine = viewer?.userId === apiKey.createdBy
  const expiresSoon = apiKey.expiresAt !== null && apiKey.expiresAt - now < EXPIRY_WARNING_MS
  const created = formatRelativeFromNow(apiKey.createdAt, now, locale)
  return (
    <li data-settings-row="" data-key-id={apiKey.id} className="flex items-start gap-3 py-3">
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex min-w-0 items-baseline gap-2">
          <p className="truncate text-sm font-medium" title={apiKey.name}>
            {apiKey.name}
          </p>
          <code className="shrink-0 font-mono text-xs text-muted-foreground">
            {formatKeyPrefix(apiKey.prefix)}
          </code>
          <ScopeSummary scopes={apiKey.scopes} />
        </div>
        <p className="text-xs text-muted-foreground">
          <time
            dateTime={new Date(apiKey.createdAt).toISOString()}
            title={formatAbsoluteTime(apiKey.createdAt, locale)}
          >
            {mine ? (
              t('auto.components.settings.cloudApi.keys.createdMine', 'Created {{time}}', {
                time: created
              })
            ) : (
              <PersonSentence
                sentence={t(
                  'auto.components.settings.cloudApi.keys.createdByPerson',
                  'Created by <person></person> {{time}}',
                  { time: created }
                )}
                name={apiKey.createdByName}
                id={apiKey.createdBy}
              />
            )}
          </time>
          <span aria-hidden> · </span>
          <span>
            {apiKey.lastUsedAt
              ? t('auto.components.settings.cloudApi.keys.lastUsed', 'Last used {{time}}', {
                  time: formatRelativeFromNow(apiKey.lastUsedAt, now, locale)
                })
              : t('auto.components.settings.cloudApi.keys.neverUsed', 'Never used')}
          </span>
          {apiKey.expiresAt !== null ? (
            <>
              <span aria-hidden> · </span>
              <span className={cn(expiresSoon && 'text-status-warning-text')}>
                {apiKey.expiresAt <= now
                  ? t('auto.components.settings.cloudApi.keys.expired', 'Expired')
                  : t('auto.components.settings.cloudApi.keys.expires', 'Expires {{time}}', {
                      time: formatRelativeFromNow(apiKey.expiresAt, now, locale)
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
        data-revoke=""
        onClick={onRevoke}
        aria-label={t('auto.components.settings.cloudApi.keys.revokeLabel', 'Revoke {{keyName}}', {
          keyName: apiKey.name
        })}
      >
        <Trash2 />
        {t('auto.components.settings.cloudApi.keys.revoke', 'Revoke')}
      </Button>
    </li>
  )
}
