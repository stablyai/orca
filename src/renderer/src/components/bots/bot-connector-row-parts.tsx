// The pieces a connector row's header is made of, shared by the row in a list and its own page.
import React from 'react'
import { Ellipsis, ExternalLink, LoaderCircle, Plus, RefreshCw, Unplug } from 'lucide-react'
import type { IntegrationCardStatusTone } from '@/components/integrations/presentation/integration-card-shell'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { useTranslate } from '@/i18n/use-translate'
import { botConnectorTitleSeparator, type BotConnectorTitle } from './bot-connector-titles'

/** A connector's one next step when it needs the owner, shown in place of its status. */
export type BotConnectorFix = {
  label: string
  onClick: () => void
  disabled?: boolean
  /** Also opens the row, when the fix continues in its panel. */
  opensRow?: boolean
}

export const STATUS_DOT_CLASSES: Record<IntegrationCardStatusTone, string> = {
  connected: 'size-1.5 shrink-0 rounded-full bg-status-success',
  attention: 'size-1.5 shrink-0 rounded-full bg-foreground',
  neutral: 'size-1.5 shrink-0 rounded-full bg-muted-foreground'
}

export function ConnectorStatus(props: {
  label: string
  tone: IntegrationCardStatusTone
  checking: boolean
}): React.JSX.Element {
  if (props.checking) {
    return <LoaderCircle className="size-4 shrink-0 animate-spin text-muted-foreground" />
  }
  return (
    <span className="flex shrink-0 items-center gap-1.5 text-xs whitespace-nowrap text-muted-foreground">
      <span className={STATUS_DOT_CLASSES[props.tone]} aria-hidden />
      {props.label}
    </span>
  )
}

/** A row's ⋯ menu: adding access first, then the connector's own page, Remove (or Disconnect) last. */
export type BotConnectorActions = {
  /** More access on the connected account: GitHub repositories or organizations, or another workspace. */
  add?: { label: string; onClick: () => void } | null
  /** Another account of the owner's on the service, e.g. a second GitHub login. */
  addAccount?: { label: string; onClick: () => void } | null
  link?: { label: string; onClick: () => void } | null
  /** Something the connector offers but doesn't need, e.g. newer permissions. */
  update?: { label: string; onClick: () => void } | null
  remove?: { label: string; onSelect: () => void; disabled?: boolean } | null
}

export function BotConnectorMenu({
  name,
  actions,
  alwaysShown = false
}: {
  name: string
  actions: BotConnectorActions
  /** On a connector's page; a row shows it on hover, focus or open. */
  alwaysShown?: boolean
}): React.JSX.Element | null {
  const t = useTranslate()
  const { add, addAccount, link, update, remove } = actions
  if (!add && !addAccount && !link && !update && !remove) {
    return null
  }
  return (
    <DropdownMenu modal={false}>
      {/* Over the stretched name button, so it opens the menu rather than the row; shown on hover, focus or open. */}
      <span
        data-shown={alwaysShown}
        className="relative shrink-0 opacity-0 group-hover:opacity-100 group-data-[state=open]:opacity-100 focus-within:opacity-100 has-[[data-state=open]]:opacity-100 data-[shown=true]:opacity-100"
      >
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={t('bots.connector.actions', '{{name}} actions', { name })}
          >
            <Ellipsis />
          </Button>
        </DropdownMenuTrigger>
      </span>
      <DropdownMenuContent align="end">
        {add ? (
          <DropdownMenuItem onSelect={add.onClick}>
            <Plus />
            {add.label}
          </DropdownMenuItem>
        ) : null}
        {addAccount ? (
          <DropdownMenuItem onSelect={addAccount.onClick}>
            <Plus />
            {addAccount.label}
          </DropdownMenuItem>
        ) : null}
        {link ? (
          <DropdownMenuItem onSelect={link.onClick}>
            <ExternalLink />
            {link.label}
          </DropdownMenuItem>
        ) : null}
        {update ? (
          <DropdownMenuItem onSelect={update.onClick}>
            <RefreshCw />
            {update.label}
          </DropdownMenuItem>
        ) : null}
        {(add || addAccount || link || update) && remove ? <DropdownMenuSeparator /> : null}
        {remove ? (
          <DropdownMenuItem
            variant="destructive"
            disabled={remove.disabled}
            onSelect={remove.onSelect}
          >
            <Unplug />
            {remove.label}
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export type BotConnectorRowFrameProps = {
  icon: React.ReactNode
  /** Replaces the muted tile around `icon`, e.g. an app's own logo on its brand tile. */
  logo?: React.ReactNode
  name: string | BotConnectorTitle
  description: React.ReactNode
  /** Null while all is well: a row shows a status only when something needs the owner. */
  status: { label: string; tone: IntegrationCardStatusTone } | null
  checking?: boolean
  fix?: BotConnectorFix | null
  /** Before the status, e.g. pending access requests. */
  notice?: React.ReactNode
  /** Between the status and the chevron. */
  trailing?: React.ReactNode
  actions?: BotConnectorActions
  /** Open on first mount, and again whenever it turns true (e.g. once a row needs the owner); closing is the owner's. */
  defaultOpen?: boolean
  /** The panel spans the row from the icon, for a list of its own. */
  widePanel?: boolean
  /** In a narrow connectors panel, the body spans the row as `widePanel` does. */
  narrowSpans?: boolean
  children: React.ReactNode
}

export function RowName({ name }: { name: string | BotConnectorTitle }): React.ReactNode {
  if (typeof name === 'string') {
    return name
  }
  return (
    <>
      {/* The service (with the separator) gives way first, so a narrow row still names its place. */}
      <span className="min-w-0 shrink-[1000] truncate whitespace-pre">
        {name.name ? `${name.service}${botConnectorTitleSeparator()}` : name.service}
      </span>
      {name.name ? <span className="min-w-0 truncate">{name.name}</span> : null}
    </>
  )
}

/** The fix when the row needs the owner, else its status, if any. */
export function RowFixOrStatus({
  props,
  onOpen
}: {
  props: BotConnectorRowFrameProps
  onOpen: () => void
}): React.JSX.Element | null {
  const { fix, actions } = props
  if (fix) {
    return (
      <span className="relative shrink-0">
        <Button
          variant={actions ? 'outline' : 'link'}
          size="xs"
          disabled={fix.disabled}
          onClick={() => {
            if (fix.opensRow) {
              onOpen()
            }
            fix.onClick()
          }}
        >
          {fix.label}
        </Button>
      </span>
    )
  }
  return props.status || props.checking ? (
    <ConnectorStatus
      label={props.status?.label ?? ''}
      tone={props.status?.tone ?? 'neutral'}
      checking={props.checking === true}
    />
  ) : null
}
