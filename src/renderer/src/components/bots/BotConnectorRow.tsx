import React, { useId } from 'react'
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
import type { Bot } from '../../../../shared/bot-types'
import { BotConnectorCaption } from './bot-connector-people'
import { BotHowToAsk } from './BotHowToAsk'
import { BotWhoCanAskList, type BotWhoCanAskService } from './BotWhoCanAskList'
import { useWhoCanAskRequests } from './use-bot-who-can-ask'
import { AttentionDot } from './AttentionDot'
import { BotFoldChevron } from './BotFoldChevron'
import { BotConnectorRowKey, useBotConnectorRowOpen } from './bot-connector-row-open'
import { BotAppBrandLogo } from './apps/BotAppBrandLogo'
import type { BotConnector } from './bot-connectors'
import {
  botConnectorTitleSeparator,
  botConnectorTitleText,
  type BotConnectorTitle
} from './bot-connector-titles'

/** A connector's one next step when it needs the owner, shown in place of its status. */
export type BotConnectorFix = {
  label: string
  onClick: () => void
  disabled?: boolean
  /** Also opens the row, when the fix continues in its panel. */
  opensRow?: boolean
}

const STATUS_DOT_CLASSES: Record<IntegrationCardStatusTone, string> = {
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
  link?: { label: string; onClick: () => void } | null
  /** Something the connector offers but doesn't need, e.g. newer permissions. */
  update?: { label: string; onClick: () => void } | null
  remove?: { label: string; onSelect: () => void; disabled?: boolean } | null
}

function BotConnectorMenu({
  name,
  actions
}: {
  name: string
  actions: BotConnectorActions
}): React.JSX.Element | null {
  const t = useTranslate()
  const { add, link, update, remove } = actions
  if (!add && !link && !update && !remove) {
    return null
  }
  return (
    <DropdownMenu modal={false}>
      {/* Over the stretched name button, so it opens the menu rather than the row; shown on hover, focus or open. */}
      <span className="relative shrink-0 opacity-0 group-hover:opacity-100 group-data-[state=open]:opacity-100 focus-within:opacity-100 has-[[data-state=open]]:opacity-100">
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
        {(add || link || update) && remove ? <DropdownMenuSeparator /> : null}
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

/**
 * A row's header and the panel a click opens; connector rows, Tools and Skills fill it. The whole
 * header folds the row, and a chevron ends it, after the ⋯ menu when there are `actions`
 * (connectors). Under a `BotConnectorRowKey` the row keeps its open state for the session.
 */
export function BotConnectorRowFrame(props: {
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
}): React.JSX.Element {
  const [open, setOpen] = useBotConnectorRowOpen(props.defaultOpen ?? false)
  const panelId = useId()
  const { fix, actions, name } = props
  return (
    <div
      data-state={open ? 'open' : 'closed'}
      data-menu={actions !== undefined}
      className="group data-[menu=true]:rounded-lg data-[menu=true]:data-[state=open]:bg-accent/40"
    >
      <div className="group/header relative flex items-center gap-3 px-4 py-3 transition-colors hover:bg-accent/40 group-data-[menu=true]:rounded-lg group-data-[menu=true]:px-2 group-data-[menu=true]:py-2">
        {props.logo ?? (
          <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted">
            {props.icon}
          </span>
        )}
        <div className="min-w-0 flex-1">
          {/* Stretched over the row, so a click anywhere but the fix opens it. */}
          <button
            type="button"
            aria-expanded={open}
            aria-controls={panelId}
            onClick={() => setOpen((value) => !value)}
            className="flex max-w-full min-w-0 text-left text-sm font-medium outline-none after:absolute after:inset-0 after:rounded-[inherit] focus-visible:after:ring-[3px] focus-visible:after:ring-ring/50"
          >
            {typeof name === 'string' ? (
              name
            ) : (
              <>
                {/* The service (with the separator) gives way first, so a narrow row still names its place. */}
                <span className="min-w-0 shrink-[1000] truncate whitespace-pre">
                  {name.name ? `${name.service}${botConnectorTitleSeparator()}` : name.service}
                </span>
                {name.name ? <span className="min-w-0 truncate">{name.name}</span> : null}
              </>
            )}
          </button>
          <p className="truncate text-xs text-muted-foreground">{props.description}</p>
        </div>
        {props.notice}
        {fix ? (
          <span className="relative shrink-0">
            <Button
              variant={actions ? 'outline' : 'link'}
              size="xs"
              disabled={fix.disabled}
              onClick={() => {
                if (fix.opensRow) {
                  setOpen(true)
                }
                fix.onClick()
              }}
            >
              {fix.label}
            </Button>
          </span>
        ) : props.status || props.checking ? (
          <ConnectorStatus
            label={props.status?.label ?? ''}
            tone={props.status?.tone ?? 'neutral'}
            checking={props.checking === true}
          />
        ) : null}
        {props.trailing}
        {actions ? (
          <BotConnectorMenu
            name={typeof name === 'string' ? name : botConnectorTitleText(name)}
            actions={actions}
          />
        ) : null}
        {/* Passes clicks to the stretched name button, so it folds the row too. */}
        <BotFoldChevron open={open} className="size-4 group-hover/header:text-foreground" />
      </div>
      <div
        id={panelId}
        hidden={!open}
        data-wide={props.widePanel === true}
        data-narrow-spans={props.narrowSpans === true}
        // The connectors panel below 300 px (its px-2 aside): the indent past the logo would leave
        // the body too narrow, so it spans the row from the menu row's own inset.
        className="pr-4 pb-4 pl-15 data-[wide=true]:pl-4 group-data-[menu=true]:pr-3 group-data-[menu=true]:pb-3 group-data-[menu=true]:pl-13 group-data-[menu=true]:data-[narrow-spans=true]:@max-[284px]/connectors-panel:pl-3"
      >
        {/* A row inside the panel is not this connector. */}
        <BotConnectorRowKey.Provider value={null}>{props.children}</BotConnectorRowKey.Provider>
      </div>
    </div>
  )
}

/** An open row's label and value lines, e.g. Uses and Who can use it. */
export function BotConnectorDetails({
  rows
}: {
  rows: readonly { label: string; value: React.ReactNode }[]
}): React.JSX.Element {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 text-xs leading-5">
      {rows.map((row) => (
        <React.Fragment key={row.label}>
          <dt className="text-muted-foreground">{row.label}</dt>
          <dd className="min-w-0 text-foreground">{row.value}</dd>
        </React.Fragment>
      ))}
    </dl>
  )
}

/** Settings › Bots › Connectors: one connector as a row that opens to how to ask it, its people and actions. */
export function BotConnectorRow(props: {
  bot: Bot
  /** Drawn with the same brand logo as Add to <bot>. */
  connector: Pick<BotConnector, 'id' | 'Icon'>
  name: string | BotConnectorTitle
  description: React.ReactNode
  /** Null while all is well: a row shows a status only when something needs the owner. */
  status: { label: string; tone: IntegrationCardStatusTone } | null
  checking?: boolean
  fix?: BotConnectorFix | null
  /** Translated, with the text to type in <code>; see BotHowToAsk. */
  howToAsk: string
  /** Who can ask the bot here, the owner aside. */
  people: BotWhoCanAskService
  defaultOpen?: boolean
  add?: BotConnectorActions['add']
  /** The connector's own page, in the row's menu. */
  link?: BotConnectorActions['link']
  update?: BotConnectorActions['update']
  remove?: BotConnectorActions['remove']
  /** In place of How to ask and Who can ask: a connector's own body (Slack's). */
  body?: React.ReactNode
  /** Dialogs the row opens. */
  children?: React.ReactNode
}): React.JSX.Element {
  const t = useTranslate()
  const { bot, add, link, remove, people } = props
  const requests = useWhoCanAskRequests(bot, people)
  return (
    <BotConnectorRowFrame
      icon={null}
      logo={<BotAppBrandLogo app={props.connector} />}
      name={props.name}
      description={props.description}
      status={props.status}
      checking={props.checking}
      fix={props.fix}
      defaultOpen={props.defaultOpen}
      notice={
        requests.length > 0 ? (
          <span className="flex shrink-0 items-center gap-1.5 text-xs whitespace-nowrap text-muted-foreground">
            <AttentionDot />
            {t('settings.bots.connectorRequests', '{{count}} requests', {
              count: requests.length,
              defaultValue_one: '{{count}} request'
            })}
          </span>
        ) : null
      }
      actions={{ add, link, update: props.update, remove }}
      narrowSpans={props.body !== undefined}
    >
      {props.body ?? (
        <>
          <BotConnectorCaption title={t('bots.connector.howToAsk', 'How to ask')} />
          <p className="mb-4 text-xs leading-5 text-muted-foreground">
            <BotHowToAsk text={props.howToAsk} />
          </p>
          <BotWhoCanAskList bot={bot} service={people} />
        </>
      )}
      {props.children}
    </BotConnectorRowFrame>
  )
}
