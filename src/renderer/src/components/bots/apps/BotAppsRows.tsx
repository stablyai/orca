import React from 'react'
import { Link2, Plus, Webhook } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import type { Bot } from '../../../../../shared/bot-types'
import type { BotConnector } from '../bot-connectors'
import { RemovedGitHubOrgs } from '../github/RemovedGitHubOrgs'
import { BotAppBrandLogo } from './BotAppBrandLogo'
import { BotAppLogo, BotAppRow, BotAppRowButton } from './BotAppRow'
import {
  botAppCategoryName,
  directAppLine,
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

function AddAnotherButton({
  label,
  ariaLabel,
  onClick
}: {
  label: string
  ariaLabel: string
  onClick: () => void
}): React.JSX.Element {
  const labelRef = React.useRef<HTMLSpanElement>(null)
  const [tooltipOpen, setTooltipOpen] = React.useState(false)
  React.useLayoutEffect(() => {
    const labelElement = labelRef.current
    if (!tooltipOpen || !labelElement || typeof ResizeObserver === 'undefined') {
      return
    }
    const observer = new ResizeObserver(() => {
      if (labelElement.getClientRects().length > 0) {
        setTooltipOpen(false)
      }
    })
    observer.observe(labelElement)
    return () => observer.disconnect()
  }, [tooltipOpen])
  return (
    <Tooltip
      open={tooltipOpen}
      onOpenChange={(open) =>
        setTooltipOpen(open && labelRef.current?.getClientRects().length === 0)
      }
    >
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="xs"
          aria-label={ariaLabel}
          className="min-w-0 shrink @max-[380px]/app-row:w-6 @max-[380px]/app-row:shrink-0"
          onClick={onClick}
        >
          <Plus aria-hidden className="hidden @max-[380px]/app-row:block" />
          <span ref={labelRef} title={label} className="truncate @max-[380px]/app-row:hidden">
            {label}
          </span>
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}

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
    <BotAppRowButton
      aria-label={t('bots.connectors.manageNamed', 'Manage {{name}}', { name })}
      onClick={onClick}
      className="min-w-0 shrink"
    >
      <span className="truncate">{t('bots.connectors.manage', 'Manage')}</span>
    </BotAppRowButton>
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
        logo={<BotAppBrandLogo app={'connector' in row ? row.connector : row.app} size="catalog" />}
        added={row.added}
        name={row.name}
        tag={'tag' in row ? row.tag : undefined}
        line={directAppLine(row.app)}
        action={
          row.added ? (
            <span className="flex min-w-0 max-w-1/2 shrink items-center gap-1">
              {another && connector ? (
                <AddAnotherButton
                  label={another.label}
                  ariaLabel={another.aria}
                  onClick={() => onAnother(connector.id)}
                />
              ) : null}
              <ManageButton name={row.name} onClick={() => onManage(row)} />
            </span>
          ) : (
            <BotAppRowButton
              aria-label={t('bots.connectors.addNamed', 'Add {{name}}', { name: row.name })}
              onClick={() => onAdd(row)}
            >
              {t('bots.apps.add', 'Add')}
            </BotAppRowButton>
          )
        }
      />
      {row.added && connector?.id === 'github' ? <RemovedGitHubOrgs bot={bot} /> : null}
    </>
  )
}

/** Add apps' own entries: an app by URL, and Webhooks. */
export type CustomApp = { id: 'url' | 'webhooks'; name: string; line: string; added: boolean }

export function useCustomApps(webhooks: 'off' | 'available' | 'added'): CustomApp[] {
  const t = useTranslate()
  return [
    {
      id: 'url',
      name: t('bots.apps.addByUrl', 'Add by URL'),
      line: t('bots.apps.custom.rowLine', 'Any MCP server'),
      added: false
    },
    ...(webhooks === 'off'
      ? []
      : [
          {
            id: 'webhooks' as const,
            name: t('bots.webhooks.name', 'Webhooks'),
            line: t('bots.apps.webhooks.line', 'Events from any tool or script'),
            added: webhooks === 'added'
          }
        ])
  ]
}

export function CustomAppRow({
  app,
  onOpen,
  onManage
}: {
  app: CustomApp
  onOpen: (id: CustomApp['id']) => void
  onManage: () => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <BotAppRow
      logo={
        app.id === 'url' ? (
          <BotAppLogo plain icon={<Link2 className="size-5" />} size="catalog" />
        ) : (
          <BotAppLogo icon={<Webhook className="size-5" />} size="catalog" />
        )
      }
      added={app.added}
      name={app.name}
      line={app.line}
      action={
        app.added ? (
          <ManageButton name={app.name} onClick={onManage} />
        ) : app.id === 'url' ? (
          <BotAppRowButton
            aria-label={t('bots.apps.custom.title', 'Add an app by URL')}
            onClick={() => onOpen('url')}
          >
            {t('bots.apps.add', 'Add')}
          </BotAppRowButton>
        ) : (
          <BotAppRowButton
            aria-label={t('bots.apps.setUpNamed', 'Set up {{name}}', { name: app.name })}
            onClick={() => onOpen('webhooks')}
          >
            {t('bots.apps.setUp', 'Set up')}
          </BotAppRowButton>
        )
      }
    />
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
  onAddByUrl: () => void
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
          <Button variant="ghost" size="sm" onClick={onAddByUrl}>
            <Plus />
            {t('bots.apps.addByUrl', 'Add by URL')}
          </Button>
        </div>
      ) : (
        <Button variant="outline" size="sm" onClick={onSearchAll}>
          {t('bots.apps.searchAll', 'Search all apps')}
        </Button>
      )}
    </div>
  )
}
