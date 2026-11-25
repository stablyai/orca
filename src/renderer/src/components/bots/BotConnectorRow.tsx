import React, { useContext, useId } from 'react'
import type { IntegrationCardStatusTone } from '@/components/integrations/presentation/integration-card-shell'
import { useTranslate } from '@/i18n/use-translate'
import type { Bot } from '../../../../shared/bot-types'
import { BotConnectorSection } from './bot-connector-people'
import { BotHowToAsk } from './BotHowToAsk'
import { BotWhoCanAskList, type BotWhoCanAskService } from './BotWhoCanAskList'
import { useWhoCanAskRequests } from './use-bot-who-can-ask'
import { AttentionDot } from './AttentionDot'
import { BotFoldChevron } from './BotFoldChevron'
import {
  BotConnectorPageSections,
  BotConnectorPageShown,
  BotConnectorRowKey,
  useBotRowOpen
} from './bot-connector-page'
import { BotAppBrandLogo } from './apps/BotAppBrandLogo'
import type { BotConnector } from './bot-connectors'
import { botConnectorTitleText, type BotConnectorTitle } from './bot-connector-titles'
import {
  BotConnectorMenu,
  RowFixOrStatus,
  RowName,
  type BotConnectorActions,
  type BotConnectorFix,
  type BotConnectorRowFrameProps
} from './bot-connector-row-parts'
import { BotConnectorPageRow } from './BotConnectorPageRow'

export {
  ConnectorStatus,
  type BotConnectorActions,
  type BotConnectorFix
} from './bot-connector-row-parts'

/**
 * A row's header and what a click opens; connector rows, Tools and Skills fill it. In a connector
 * list (under `BotConnectorPageShown` and a `BotConnectorRowKey`) a click shows the connector's own
 * page in place of the list; elsewhere the row folds open in place, a chevron ending its header
 * after the ⋯ menu when there are `actions` (connectors).
 */
export function BotConnectorRowFrame(props: BotConnectorRowFrameProps): React.JSX.Element {
  const rowKey = useContext(BotConnectorRowKey)
  const page = useContext(BotConnectorPageShown)
  return rowKey !== null && page !== undefined ? (
    <BotConnectorPageRow {...props} rowKey={rowKey} page={page} />
  ) : (
    <BotConnectorFoldRow {...props} />
  )
}

/** A row that folds open in place, e.g. Tools and Skills. */
function BotConnectorFoldRow(props: BotConnectorRowFrameProps): React.JSX.Element {
  const [open, setOpen] = useBotRowOpen(props.defaultOpen ?? false)
  const panelId = useId()
  const { actions, name } = props
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
            <RowName name={name} />
          </button>
          <p className="truncate text-xs text-muted-foreground">{props.description}</p>
        </div>
        {props.notice}
        <RowFixOrStatus props={props} onOpen={() => setOpen(true)} />
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
        {props.children}
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
    <BotConnectorSection>
      <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 text-xs leading-5">
        {rows.map((row) => (
          <React.Fragment key={row.label}>
            <dt className="text-muted-foreground">{row.label}</dt>
            <dd className="min-w-0 text-foreground">{row.value}</dd>
          </React.Fragment>
        ))}
      </dl>
    </BotConnectorSection>
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
          <BotConnectorSection title={t('bots.connector.howToAsk', 'How to ask')}>
            <p className="mb-4 text-xs leading-5 text-muted-foreground">
              <BotHowToAsk text={props.howToAsk} />
            </p>
          </BotConnectorSection>
          <BotWhoCanAskList bot={bot} service={people} />
        </>
      )}
      <BotConnectorPageSections.Provider value={false}>
        {props.children}
      </BotConnectorPageSections.Provider>
    </BotConnectorRowFrame>
  )
}
