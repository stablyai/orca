// Settings › Orca Account › Linked accounts: the Slack, GitHub and Linear people linked to the account,
// several per service. Presentational; LinkedAccountsSettings feeds it the host's state.
import { useState, type ComponentType } from 'react'
import { Loader2, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/class-names'
import { useTranslate } from '@/i18n/use-translate'
import { SettingsSubsectionHeader } from '@/components/settings/form-controls/SettingsFormControls'
import { BOT_CONNECTORS } from '@/components/bots/bot-connectors'
import {
  CONNECTOR_LINK_SOURCES,
  type ConnectorLink,
  type ConnectorLinkSource
} from '../../../../../../shared/connectors/connector-links-contract'

/** One service's sign-in trip: `null` where this window can't start one; `canLink` false where the
 *  host's cloud has no sign-in for the service. */
export type LinkedAccountsTrip = { waiting: boolean; error: string | null; canLink: boolean } | null

type Trips = Readonly<Record<ConnectorLinkSource, LinkedAccountsTrip>>

const ROW = 'group flex h-10 items-center gap-3 rounded-md px-2.5'
const ROW_HOVER =
  'hover:bg-accent/50 focus-within:bg-accent/50 has-[[data-state=open]]:bg-accent/50'
// Kept focusable while hidden so keyboard users reach it; focus inside the row reveals it.
const REVEAL =
  'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 data-[state=open]:opacity-100'
const ACTION = 'text-muted-foreground hover:text-foreground'

function connectorOf(source: ConnectorLinkSource): {
  label: string
  Icon: ComponentType<{ className?: string }> | undefined
} {
  const connector = BOT_CONNECTORS.find((entry) => entry.id === source)
  return { label: connector?.label ?? source, Icon: connector?.Icon }
}

function canStartLink(trip: LinkedAccountsTrip): boolean {
  return Boolean(trip?.canLink && !trip.waiting)
}

function UnlinkButton({
  link,
  label,
  onUnlink
}: {
  link: ConnectorLink
  label: string
  onUnlink: (link: ConnectorLink) => void
}): React.JSX.Element {
  const t = useTranslate()
  const [open, setOpen] = useState(false)
  const name = link.name || link.userId
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button size="sm" variant="ghost-on-accent" className={cn(ACTION, REVEAL)}>
          {t('settings.linkedAccounts.unlink', 'Unlink')}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 space-y-3 p-3.5">
        <div className="space-y-1">
          <p className="text-sm font-medium">
            {link.workspaceName
              ? t('settings.linkedAccounts.unlinkTitleIn', 'Unlink {{name}} in {{workspace}}?', {
                  name,
                  workspace: link.workspaceName
                })
              : t('settings.linkedAccounts.unlinkTitle', 'Unlink {{name}} on {{service}}?', {
                  name,
                  service: label
                })}
          </p>
          <p className="text-xs text-muted-foreground">
            {link.workspaceName
              ? t(
                  'settings.linkedAccounts.unlinkNoteWorkspace',
                  'Bots shared with you won’t know it’s you in that workspace.'
                )
              : t(
                  'settings.linkedAccounts.unlinkNote',
                  'Bots shared with you won’t know it’s you on {{service}}.',
                  { service: label }
                )}
          </p>
        </div>
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="outline" onClick={() => setOpen(false)}>
            {t('settings.linkedAccounts.cancel', 'Cancel')}
          </Button>
          <Button
            size="sm"
            variant="destructive"
            onClick={() => {
              setOpen(false)
              onUnlink(link)
            }}
          >
            {t('settings.linkedAccounts.unlink', 'Unlink')}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

function LinkedAccountsSourceRows({
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
  const { label, Icon } = connectorOf(source)
  const glyph = Icon ? <Icon className="size-3.5 shrink-0" /> : <span className="size-3.5" />
  return (
    <>
      {links.map((link) => (
        <div key={`${link.workspaceId}\0${link.userId}`} className={cn(ROW, ROW_HOVER)}>
          {glyph}
          <div className="flex min-w-0 flex-1 items-baseline gap-2">
            <p className="truncate text-sm">{link.name || link.userId}</p>
            <p className="truncate text-xs text-muted-foreground">
              {link.workspaceName ? `${label} · ${link.workspaceName}` : label}
            </p>
          </div>
          <UnlinkButton link={link} label={label} onUnlink={onUnlink} />
        </div>
      ))}
      {trip?.waiting ? (
        <div className={ROW}>
          <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" aria-hidden />
          <p className="min-w-0 flex-1 truncate text-sm">
            {t('settings.linkedAccounts.waiting', 'Waiting for {{service}}…', { service: label })}
          </p>
          <Button size="sm" variant="ghost" className={ACTION} onClick={() => onCancel(source)}>
            {t('settings.linkedAccounts.cancel', 'Cancel')}
          </Button>
        </div>
      ) : links.length === 0 ? (
        <div className={cn(ROW, canStartLink(trip) && ROW_HOVER)}>
          {glyph}
          <p className="min-w-0 flex-1 truncate text-sm">{label}</p>
          {/* "Not linked" and Link share one cell, so hover swaps them in place. */}
          <div className="grid items-center justify-items-end">
            <p
              className={cn(
                'col-start-1 row-start-1 pr-3 text-xs text-muted-foreground',
                canStartLink(trip) && 'group-hover:invisible group-focus-within:invisible'
              )}
            >
              {t('settings.linkedAccounts.none', 'Not linked')}
            </p>
            {canStartLink(trip) ? (
              <Button
                size="sm"
                variant="ghost-on-accent"
                className={cn('col-start-1 row-start-1', ACTION, REVEAL)}
                onClick={() => onLink(source)}
              >
                {t('settings.linkedAccounts.link', 'Link')}
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
      {trip?.error ? (
        <p role="alert" className="px-2.5 pb-1 pl-9 text-xs text-destructive">
          {trip.error}
        </p>
      ) : null}
    </>
  )
}

function LinkAccountMenu({
  links,
  trips,
  onLink
}: {
  links: readonly ConnectorLink[]
  trips: Trips
  onLink: (source: ConnectorLinkSource) => void
}): React.JSX.Element | null {
  const t = useTranslate()
  const sources = CONNECTOR_LINK_SOURCES.filter((source) => canStartLink(trips[source]))
  if (sources.length === 0) {
    return null
  }
  const label = t('settings.linkedAccounts.linkAccount', 'Link account')
  return (
    <DropdownMenu modal={false}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={label}
              className="mr-2 text-muted-foreground"
            >
              <Plus className="size-4" />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={4}>
          {label}
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="min-w-52">
        {sources.map((source) => {
          const { label: service, Icon } = connectorOf(source)
          return (
            <DropdownMenuItem key={source} onSelect={() => onLink(source)}>
              {Icon ? <Icon className="size-3.5" /> : null}
              <span className="flex-1">{service}</span>
              {links.some((link) => link.source === source) ? (
                <span className="text-xs text-muted-foreground">
                  {t('settings.linkedAccounts.anotherAccount', 'Another account')}
                </span>
              ) : null}
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
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
  trips: Trips
  onLink: (source: ConnectorLinkSource) => void
  onCancel: (source: ConnectorLinkSource) => void
  onUnlink: (link: ConnectorLink) => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <section className="space-y-2">
      <SettingsSubsectionHeader
        className="items-center"
        title={t('settings.linkedAccounts.title', 'Linked accounts')}
        action={<LinkAccountMenu links={links} trips={trips} onLink={onLink} />}
      />
      <div className="-mx-2.5">
        {CONNECTOR_LINK_SOURCES.map((source) => (
          <LinkedAccountsSourceRows
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
