// Settings › Orca Account › Linked accounts: the Slack, GitHub and Linear people linked to the account,
// several per service. Presentational; LinkedAccountsSettings feeds it the host's state.
import { Loader2, Plus, UserRound } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { SettingsSubsectionHeader } from '@/components/settings/form-controls/SettingsFormControls'
import { BOT_CONNECTORS } from '@/components/bots/bot-connectors'
import {
  CONNECTOR_LINK_SOURCES,
  type ConnectorLink,
  type ConnectorLinkSource
} from '../../../../../../shared/connectors/connector-links-contract'

/** One service's sign-in trip: `null` where this window can't start one (e.g. Slack until it can). */
export type LinkedAccountsTrip = { waiting: boolean; error: string | null } | null

function LinkedAccountRow({
  link,
  onUnlink
}: {
  link: ConnectorLink
  onUnlink: (link: ConnectorLink) => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <div className="flex items-center gap-3 py-1.5 pl-9">
      <div className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <UserRound className="size-3.5" aria-hidden />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm">{link.name || link.userId}</p>
        {link.workspaceName ? (
          <p className="truncate text-xs text-muted-foreground">{link.workspaceName}</p>
        ) : null}
      </div>
      <Button size="sm" variant="outline" onClick={() => onUnlink(link)}>
        {t('settings.linkedAccounts.unlink', 'Unlink')}
      </Button>
    </div>
  )
}

function LinkedAccountsGroup({
  source,
  links,
  trip,
  onLink,
  onCancel,
  onUnlink
}: {
  source: ConnectorLinkSource
  links: readonly ConnectorLink[]
  trip: LinkedAccountsTrip
  onLink: (source: ConnectorLinkSource) => void
  onCancel: (source: ConnectorLinkSource) => void
  onUnlink: (link: ConnectorLink) => void
}): React.JSX.Element {
  const t = useTranslate()
  const connector = BOT_CONNECTORS.find((entry) => entry.id === source)
  const label = connector?.label ?? source
  const Icon = connector?.Icon
  return (
    <div className="space-y-1 px-4 py-3">
      <div className="flex min-h-8 items-center gap-3">
        <div className="flex size-6 shrink-0 items-center justify-center rounded-md border border-border">
          {Icon ? <Icon className="size-3.5" /> : null}
        </div>
        <p className="min-w-0 flex-1 truncate text-sm font-medium">{label}</p>
        {trip && !trip.waiting ? (
          <Button size="sm" variant="outline" onClick={() => onLink(source)}>
            <Plus />
            {links.length > 0
              ? t('settings.linkedAccounts.linkAnother', 'Link another')
              : t('settings.linkedAccounts.link', 'Link')}
          </Button>
        ) : null}
      </div>
      {links.map((link) => (
        <LinkedAccountRow
          key={`${link.workspaceId}\0${link.userId}`}
          link={link}
          onUnlink={onUnlink}
        />
      ))}
      {trip?.waiting ? (
        <div className="flex items-center gap-3 py-1.5 pl-9">
          <div className="flex size-6 shrink-0 items-center justify-center">
            <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden />
          </div>
          <p className="min-w-0 flex-1 truncate text-sm">
            {t('settings.linkedAccounts.waiting', 'Waiting for {{service}}…', { service: label })}
          </p>
          <Button size="sm" variant="outline" onClick={() => onCancel(source)}>
            {t('settings.linkedAccounts.cancel', 'Cancel')}
          </Button>
        </div>
      ) : links.length === 0 ? (
        <p className="py-1 pl-9 text-xs text-muted-foreground">
          {t('settings.linkedAccounts.none', 'Not linked')}
        </p>
      ) : null}
      {trip?.error ? (
        <p role="alert" className="pl-9 text-xs text-destructive">
          {trip.error}
        </p>
      ) : null}
    </div>
  )
}

export function LinkedAccountsList({
  links,
  trips,
  onLink,
  onCancel,
  onUnlink
}: {
  links: readonly ConnectorLink[]
  trips: Readonly<Record<ConnectorLinkSource, LinkedAccountsTrip>>
  onLink: (source: ConnectorLinkSource) => void
  onCancel: (source: ConnectorLinkSource) => void
  onUnlink: (link: ConnectorLink) => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <section className="space-y-3">
      <SettingsSubsectionHeader title={t('settings.linkedAccounts.title', 'Linked accounts')} />
      <div className="divide-y divide-border rounded-lg border border-border">
        {CONNECTOR_LINK_SOURCES.map((source) => (
          <LinkedAccountsGroup
            key={source}
            source={source}
            links={links.filter((link) => link.source === source)}
            trip={trips[source]}
            onLink={onLink}
            onCancel={onCancel}
            onUnlink={onUnlink}
          />
        ))}
      </div>
    </section>
  )
}
