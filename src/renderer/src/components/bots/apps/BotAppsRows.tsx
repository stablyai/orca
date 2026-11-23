import React from 'react'
import { Plus, Webhook } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import type { Bot } from '../../../../../shared/bot-types'
import type { BotConnector } from '../bot-connectors'
import { RemovedGitHubOrgs } from '../github/RemovedGitHubOrgs'
import { BotAppBrandLogo } from './BotAppBrandLogo'
import { BotToolLogo } from './BotToolAppRow'
import type { BotToolApp } from './bot-tool-apps'
import { botToolSubtitle, botToolTitle } from '../../../../../shared/bots/bot-tool-labels'
import { BotAppCaption, BotAppLogo, BotAppRow } from './BotAppRow'
import {
  botAppCategoryName,
  directAppLine,
  matchesAppQuery,
  type BotAppCategory,
  type BotDirectApp
} from './bot-app-catalog'

/** A direct app as the dialog lists it, under the name it shows, and whether the bot has it. */
export type DirectRow = { name: string; added: boolean } & (
  | { app: Extract<BotDirectApp, { route: 'connector' }>; connector: BotConnector }
  | {
      app: Extract<BotDirectApp, { route: 'mcp' }>
      /** The site or host it was added at, when not the default. */
      tag?: string
    }
)

/** A connected row's action: the bot's Connectors tab. */
export function ManageButton({
  name,
  onClick
}: {
  name: string
  onClick: () => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <Button
      variant="ghost"
      size="xs"
      aria-label={t('bots.connectors.manageNamed', 'Manage {{name}}', { name })}
      onClick={onClick}
    >
      {t('bots.connectors.manage', 'Manage')}
    </Button>
  )
}

/** A direct app: Add opens its setup; once on the bot, Manage (and, for a connector, another workspace). */
export function DirectAppRow({
  bot,
  row,
  onAdd,
  onAnother,
  onManage
}: {
  bot: Bot
  row: DirectRow
  onAdd: (row: DirectRow) => void
  /** Another workspace or org for a connector the bot has. */
  onAnother: (connector: BotConnector['id']) => void
  onManage: (row: DirectRow) => void
}): React.JSX.Element {
  const t = useTranslate()
  const connector = 'connector' in row ? row.connector : null
  // A bot on Slack, Linear or GitHub can join another workspace or org; Google is once per bot.
  const another =
    row.added && connector && connector.id !== 'google' && connector.id !== 'feishu-local'
      ? connector.id === 'github'
        ? {
            label: t('bots.connectors.addOrg', 'Add org'),
            aria: t('bots.connectors.addAnotherOrg', 'Add another org')
          }
        : {
            label: t('bots.connectors.addWorkspace', 'Add workspace'),
            aria: t('bots.connectors.addAnotherWorkspace', 'Add another workspace')
          }
      : null
  return (
    <>
      <BotAppRow
        logo={<BotAppBrandLogo app={'connector' in row ? row.connector : row.app} />}
        name={row.name}
        tag={'tag' in row ? row.tag : undefined}
        line={directAppLine(row.app)}
        action={
          row.added ? (
            <span className="flex shrink-0 items-center gap-1">
              {another && connector ? (
                <Button
                  variant="ghost"
                  size="xs"
                  aria-label={another.aria}
                  onClick={() => onAnother(connector.id)}
                >
                  {another.label}
                </Button>
              ) : null}
              <ManageButton name={row.name} onClick={() => onManage(row)} />
            </span>
          ) : (
            <Button
              variant="outline"
              size="xs"
              aria-label={t('bots.connectors.addNamed', 'Add {{name}}', { name: row.name })}
              onClick={() => onAdd(row)}
            >
              {t('bots.apps.add', 'Add')}
            </Button>
          )
        }
      />
      {row.added && connector?.id === 'github' ? <RemovedGitHubOrgs bot={bot} /> : null}
    </>
  )
}

/** Nothing matches: Clear search and Add by URL, or, inside a narrower list, Search all apps. */
export function BotAppsNoMatch({
  where,
  query,
  botName,
  onClear,
  onSearchAll,
  onAddByUrl
}: {
  where: 'all' | 'mine' | BotAppCategory
  query: string
  botName: string
  onClear: () => void
  onSearchAll: () => void
  onAddByUrl: (() => void) | null
}): React.JSX.Element {
  const t = useTranslate()
  const shown = query.trim()
  return (
    <div className="flex flex-col items-center gap-3.5 px-3 pt-12 pb-3 text-center text-sm text-muted-foreground">
      {where === 'all'
        ? t('bots.apps.noMatch', 'No app matches “{{query}}”.', { query: shown })
        : where === 'mine'
          ? t('bots.apps.noMatchMine', 'Nothing on {{bot}} matches “{{query}}”.', {
              bot: botName,
              query: shown
            })
          : t('bots.apps.noMatchCategory', 'Nothing in {{category}} matches “{{query}}”.', {
              category: botAppCategoryName(where),
              query: shown
            })}
      {where === 'all' ? (
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={onClear}>
            {t('bots.connectors.clearSearch', 'Clear search')}
          </Button>
          {onAddByUrl ? (
            <Button variant="ghost" size="sm" onClick={onAddByUrl}>
              <Plus />
              {t('bots.apps.addByUrl', 'Add by URL')}
            </Button>
          ) : null}
        </div>
      ) : (
        <Button variant="outline" size="sm" onClick={onSearchAll}>
          {t('bots.apps.searchAll', 'Search all apps')}
        </Button>
      )}
    </div>
  )
}

/** On <bot>: every route the bot has, in name order, each with Manage. */
export function BotAppsMineList({
  botName,
  query,
  direct,
  renderDirect,
  byUrl,
  webhooks,
  composio,
  onManage,
  empty
}: {
  botName: string
  query: string
  direct: readonly DirectRow[]
  renderDirect: (row: DirectRow) => React.ReactNode
  /** The apps the bot has that were added by URL. */
  byUrl: readonly BotToolApp[]
  webhooks: boolean
  /** The bot's Composio sign-ins: the app and who it signed in as. */
  composio: readonly { slug: string; name: string; line: string }[]
  onManage: () => void
  empty: React.ReactNode
}): React.JSX.Element {
  const t = useTranslate()
  const webhooksName = t('bots.webhooks.name', 'Webhooks')
  const rows = [
    ...direct
      .filter((row) => matchesAppQuery(query, row.name, directAppLine(row.app)))
      .map((row) => ({ name: row.name, node: renderDirect(row) })),
    ...byUrl
      .map(({ tool }) => ({ tool, name: botToolTitle(tool.name), line: botToolSubtitle(tool) }))
      .filter((app) => matchesAppQuery(query, app.name, app.line))
      .map((app) => ({
        name: app.name,
        node: (
          <BotAppRow
            key={`tool:${app.tool.name}`}
            logo={<BotToolLogo name={app.tool.name} detail={app.tool.detail} />}
            name={app.name}
            line={app.line}
            action={<ManageButton name={app.name} onClick={onManage} />}
          />
        )
      })),
    ...(webhooks && matchesAppQuery(query, webhooksName)
      ? [
          {
            name: webhooksName,
            node: (
              <BotAppRow
                key="webhooks"
                logo={<BotAppLogo icon={<Webhook className="size-5" />} />}
                name={webhooksName}
                line={t('bots.apps.webhooks.line', 'Events from any tool or script')}
                action={<ManageButton name={webhooksName} onClick={onManage} />}
              />
            )
          }
        ]
      : []),
    ...composio
      .filter((app) => matchesAppQuery(query, app.name, app.line))
      .map((app) => ({
        name: app.name,
        node: (
          <BotAppRow
            key={`composio:${app.slug}`}
            logo={<BotAppLogo slug={app.slug} />}
            name={app.name}
            tag={t('bots.apps.viaComposio', 'via Composio')}
            line={app.line}
            action={<ManageButton name={app.name} onClick={onManage} />}
          />
        )
      }))
  ].sort((a, b) => a.name.localeCompare(b.name))
  if (rows.length === 0) {
    return <>{empty}</>
  }
  const title = t('bots.apps.onBot', 'On {{bot}}', { bot: botName })
  return (
    <section aria-label={title}>
      <BotAppCaption title={title} count={rows.length} />
      <ul className="flex flex-col">{rows.map((row) => row.node)}</ul>
    </section>
  )
}
