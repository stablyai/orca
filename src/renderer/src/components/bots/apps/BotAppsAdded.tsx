// What the bot already has, in Add apps: the header's "N added" toggle with a few of their logos,
// and the Added list it shows. Both read one list, so the faces are the list's first rows.
import React from 'react'
import { ChevronRight, Globe, Webhook } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { botToolSubtitle, botToolTitle } from '../../../../../shared/bots/bot-tool-labels'
import { BotAppBrandLogo } from './BotAppBrandLogo'
import { BotAppCaption, BotAppGrid, BotAppLogo, BotAppRow } from './BotAppRow'
import { ManageButton, type DirectRow } from './BotAppsRows'
import { directAppLine, matchesAppQuery } from './bot-app-catalog'
import type { BotToolApp } from './bot-tool-apps'

export type BotAddedSources = {
  direct: readonly DirectRow[]
  /** The apps the bot has that were added by URL. */
  byUrl: readonly BotToolApp[]
  webhooks: boolean
  /** The bot's Composio sign-ins: the app and who it signed in as. */
  composio: readonly { slug: string; name: string; line: string }[]
}

type AddedApp = {
  key: string
  name: string
  line: string
  logo: (size: 'sm' | 'catalog') => React.ReactNode
  direct?: DirectRow
  viaComposio?: boolean
}

/** Every route the bot has, in name order. */
function useAddedApps({ direct, byUrl, webhooks, composio }: BotAddedSources): AddedApp[] {
  const t = useTranslate()
  const webhooksName = t('bots.webhooks.name', 'Webhooks')
  return [
    ...direct.map((row): AddedApp => ({
      key: `direct:${row.name}`,
      name: row.name,
      line: directAppLine(row.app),
      logo: (size) => (
        <BotAppBrandLogo app={'connector' in row ? row.connector : row.app} size={size} />
      ),
      direct: row
    })),
    ...byUrl.map(({ tool }): AddedApp => {
      const name = botToolTitle(tool.name)
      const initial = Array.from(name.trim())[0]?.toLocaleUpperCase()
      return {
        key: `tool:${tool.name}`,
        name,
        line: botToolSubtitle(tool),
        logo: (size) => (
          <BotAppLogo
            plain
            icon={
              size === 'sm' && initial ? (
                <span className="text-3xs font-semibold">{initial}</span>
              ) : (
                <Globe className="size-5" />
              )
            }
            size={size}
          />
        )
      }
    }),
    ...(webhooks
      ? [
          {
            key: 'webhooks',
            name: webhooksName,
            line: t('bots.apps.webhooks.line', 'Events from any tool or script'),
            logo: (size: 'sm' | 'catalog') => (
              <BotAppLogo
                icon={<Webhook className={size === 'sm' ? 'size-3' : 'size-5'} />}
                size={size}
              />
            )
          }
        ]
      : []),
    ...composio.map((app): AddedApp => ({
      key: `composio:${app.slug}`,
      name: app.name,
      line: app.line,
      logo: (size) => <BotAppLogo slug={app.slug} size={size} />,
      viaComposio: true
    }))
  ].sort((a, b) => a.name.localeCompare(b.name))
}

const FACES = 3

/** "N added": up to three of the bot's logos and the count; toggles the Added list. */
export function BotAppsAddedButton({
  sources,
  pressed,
  onToggle
}: {
  sources: BotAddedSources
  pressed: boolean
  onToggle: () => void
}): React.JSX.Element | null {
  const t = useTranslate()
  const apps = useAddedApps(sources)
  if (apps.length === 0) {
    return null
  }
  const extra = apps.length - FACES
  return (
    <Button
      variant={pressed ? 'default' : 'ghost'}
      size="pill"
      aria-pressed={pressed}
      onClick={onToggle}
      className="h-7.5"
    >
      <span aria-hidden className="flex">
        {apps.slice(0, FACES).map((app) => (
          <span
            key={app.key}
            className="relative -ml-1.25 rounded ring-2 ring-dialog-surface first:ml-0 after:pointer-events-none after:absolute after:inset-0 after:rounded after:ring-1 after:ring-border after:ring-inset"
          >
            {app.logo('sm')}
          </span>
        ))}
        {extra > 0 ? (
          <span className="relative -ml-1.25 flex size-5 items-center justify-center rounded border border-border bg-muted text-3xs font-medium text-foreground tabular-nums ring-2 ring-dialog-surface">
            +{extra}
          </span>
        ) : null}
      </span>
      {t('bots.apps.addedCount', '{{count}} added', { count: apps.length })}
      <ChevronRight className="size-3.5" />
    </Button>
  )
}

/** Added: every route the bot has, each with Manage. */
export function BotAppsAddedList({
  sources,
  query,
  renderDirect,
  onManage,
  empty
}: {
  sources: BotAddedSources
  query: string
  renderDirect: (row: DirectRow) => React.ReactNode
  onManage: () => void
  empty: React.ReactNode
}): React.JSX.Element {
  const t = useTranslate()
  const apps = useAddedApps(sources).filter((app) => matchesAppQuery(query, app.name, app.line))
  if (apps.length === 0) {
    return <>{empty}</>
  }
  const title = t('bots.apps.addedCaption', 'Added')
  return (
    <section aria-label={title}>
      <BotAppCaption title={title} count={apps.length} />
      <BotAppGrid>
        {apps.map((app) =>
          app.direct ? (
            <React.Fragment key={app.key}>{renderDirect(app.direct)}</React.Fragment>
          ) : (
            <BotAppRow
              key={app.key}
              logo={app.logo('catalog')}
              added
              name={app.name}
              tag={app.viaComposio ? t('bots.apps.viaComposio', 'via Composio') : undefined}
              line={app.line}
              action={<ManageButton name={app.name} onClick={onManage} />}
            />
          )
        )}
      </BotAppGrid>
    </section>
  )
}
