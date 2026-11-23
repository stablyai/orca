// Add to <bot>'s Composio parts: the curated section under All apps, the full catalog behind
// "Browse all Composio apps" (read with the owner's key), and the With Composio search group.
import React from 'react'
import type { BotRef } from '@/lib/bot-hosts'
import { ArrowRight, LoaderCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import type { ComposioApp } from '../../../../../shared/composio/composio-apps'
import {
  COMPOSIO_CURATED_APPS,
  type ComposioCuratedApp
} from '../../../../../shared/composio/composio-curated-apps'
import { composioCuratedAppLine } from '../../../../../shared/bots/bot-app-lines'
import { useComposioApps } from '../composio/ComposioCatalog'
import type { ComposioBotView } from '../composio/composio-client'
import { BotAppCaption, BotAppLogo, BotAppRow } from './BotAppRow'
import { COMPOSIO_FIRST_LOOK, curatedComposioApps, matchesAppQuery } from './bot-app-catalog'

/** A Composio app as a row shows it: curated, or one of Composio's own. */
export type ComposioPick = {
  slug: string
  name: string
  line: string
  logo?: string | null
  signIn?: ComposioApp['signIn']
}

export type ComposioActions = {
  add: (app: ComposioPick) => void
  /** Back to a sign-in under way. */
  resume: (app: ComposioPick) => void
  manage: () => void
}

const curatedPicks = (apps: readonly ComposioCuratedApp[], t: ReturnType<typeof useTranslate>) =>
  apps.map((app): ComposioPick => ({
    slug: app.slug,
    name: app.name,
    line: composioCuratedAppLine(app, t)
  }))

/** The bot's sign-in per app, its working one first. */
export function composioSignedIn(view: ComposioBotView): Map<string, string | null> {
  const signedIn = new Map<string, string | null>()
  for (const entry of view.connections?.connections ?? []) {
    if (entry.status !== 'pending' && (!signedIn.has(entry.app) || entry.status === 'active')) {
      signedIn.set(entry.app, entry.label)
    }
  }
  return signedIn
}

function ComposioAppItem({
  app,
  view,
  actions
}: {
  app: ComposioPick
  view: ComposioBotView
  actions: ComposioActions
}): React.JSX.Element {
  const t = useTranslate()
  const signedIn = composioSignedIn(view)
  const pending = (view.connections?.pending ?? []).some((entry) => entry.app === app.slug)
  const label = signedIn.get(app.slug)
  let action: React.ReactNode
  if (signedIn.has(app.slug)) {
    action = (
      <Button
        variant="ghost"
        size="xs"
        aria-label={t('bots.connectors.manageNamed', 'Manage {{name}}', { name: app.name })}
        onClick={actions.manage}
      >
        {t('bots.connectors.manage', 'Manage')}
      </Button>
    )
  } else if (pending) {
    action = (
      <Button variant="ghost" size="xs" onClick={() => actions.resume(app)}>
        <LoaderCircle className="animate-spin" />
        {t('bots.apps.signingIn', 'Signing in')}
      </Button>
    )
  } else {
    action = (
      <Button
        variant="outline"
        size="xs"
        aria-label={t('bots.connectors.addNamed', 'Add {{name}}', { name: app.name })}
        onClick={() => actions.add(app)}
      >
        {t('bots.apps.add', 'Add')}
      </Button>
    )
  }
  return (
    <BotAppRow
      logo={<BotAppLogo slug={app.slug} logo={app.logo} />}
      name={app.name}
      line={label ?? app.line}
      action={action}
    />
  )
}

/** "More apps with Composio": a few curated apps, then the full catalog. */
export function ComposioSection({
  view,
  actions,
  onBrowseAll,
  alone
}: {
  view: ComposioBotView
  actions: ComposioActions
  onBrowseAll: () => void
  /** Its own rail entry, rather than under the direct apps. */
  alone: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const apps = curatedComposioApps(new Set(composioSignedIn(view).keys()))
  return (
    <section
      aria-label={t('bots.composio.group', 'More apps with Composio')}
      data-alone={alone}
      className="mt-3.5 border-t border-border pt-1 data-[alone=true]:mt-0 data-[alone=true]:border-t-0 data-[alone=true]:pt-0"
    >
      <BotAppCaption title={t('bots.composio.group', 'More apps with Composio')} />
      <p className="px-2 pb-1.5 text-xs text-muted-foreground">
        {t('bots.apps.composio.note', 'These connect through your Composio account.')}
      </p>
      <ul className="flex flex-col">
        {curatedPicks(apps.slice(0, COMPOSIO_FIRST_LOOK), t).map((app) => (
          <ComposioAppItem key={app.slug} app={app} view={view} actions={actions} />
        ))}
      </ul>
      <div className="flex gap-1 px-1 pt-1">
        <Button variant="ghost" size="sm" onClick={onBrowseAll}>
          {t('bots.apps.composio.browseAll', 'Browse Composio apps')}
          <ArrowRight />
        </Button>
      </div>
    </section>
  )
}

const fromCatalog = (app: ComposioApp): ComposioPick => ({
  slug: app.slug,
  name: app.name,
  line: app.description,
  logo: app.logo,
  signIn: app.signIn
})

/** Every Composio app, a page at a time, searched on Composio's side; needs the owner's key. */
export function ComposioCatalogList({
  bot,
  query,
  view,
  actions,
  empty
}: {
  bot: BotRef
  query: string
  view: ComposioBotView
  actions: ComposioActions
  /** Shown when a search finds nothing. */
  empty: React.ReactNode
}): React.JSX.Element {
  const t = useTranslate()
  const search = query.trim()
  const [attempt, setAttempt] = React.useState(0)
  const { listing, showMore } = useComposioApps(bot, search, attempt)
  if (listing.status === 'loading') {
    return (
      <p role="status" className="px-2 py-3 text-xs text-muted-foreground">
        {t('bots.composio.loading', 'Reading Composio’s apps…')}
      </p>
    )
  }
  if (listing.status === 'error') {
    return (
      <div className="flex items-center gap-2 px-2 py-3 text-xs text-muted-foreground">
        <span>
          {t('bots.composio.unread', 'Couldn’t load Composio’s apps. {{error}}', {
            error: listing.message
          })}
        </span>
        <Button size="xs" variant="ghost" onClick={() => setAttempt((value) => value + 1)}>
          {t('bots.composio.checkAgain', 'Check again')}
        </Button>
      </div>
    )
  }
  const apps = listing.page.apps.map(fromCatalog)
  if (apps.length === 0) {
    return <>{empty}</>
  }
  return (
    <>
      <BotAppCaption
        title={
          search
            ? t('bots.apps.composio.searchCaption', 'Composio apps')
            : t('bots.apps.composio.allCaption', 'All Composio apps')
        }
        count={listing.page.nextCursor ? undefined : apps.length}
      />
      <ul className="flex flex-col">
        {apps.map((app) => (
          <ComposioAppItem key={app.slug} app={app} view={view} actions={actions} />
        ))}
      </ul>
      {listing.page.nextCursor ? (
        <Button
          size="sm"
          variant="ghost"
          className="mx-auto mt-1 flex"
          disabled={listing.more}
          onClick={showMore}
        >
          {t('bots.composio.showMore', 'Show more')}
        </Button>
      ) : null}
    </>
  )
}

/** Search's With Composio group: the curated matches, and Composio's whole catalog once the key works. */
export function ComposioSearchGroup({
  bot,
  query,
  view,
  actions,
  divided,
  empty
}: {
  bot: BotRef
  query: string
  view: ComposioBotView
  actions: ComposioActions
  /** Under the direct apps' results. */
  divided: boolean
  /** Shown when nothing matches here and nothing came before. */
  empty: React.ReactNode
}): React.JSX.Element | null {
  const t = useTranslate()
  const curated = curatedPicks(COMPOSIO_CURATED_APPS, t).filter((app) =>
    matchesAppQuery(query, app.name, app.line)
  )
  if (view.status?.key === 'ok') {
    return (
      <ComposioSearchWithCatalog
        bot={bot}
        query={query}
        view={view}
        actions={actions}
        curated={curated}
        divided={divided}
        empty={empty}
      />
    )
  }
  return curated.length > 0 ? (
    <ComposioGroup apps={curated} view={view} actions={actions} divided={divided} />
  ) : divided ? null : (
    <>{empty}</>
  )
}

function ComposioSearchWithCatalog({
  bot,
  query,
  view,
  actions,
  curated,
  divided,
  empty
}: {
  bot: BotRef
  query: string
  view: ComposioBotView
  actions: ComposioActions
  curated: ComposioPick[]
  divided: boolean
  empty: React.ReactNode
}): React.JSX.Element | null {
  const t = useTranslate()
  const { listing } = useComposioApps(bot, query.trim(), 0)
  const found = listing.status === 'ready' ? listing.page.apps.map(fromCatalog) : []
  const seen = new Set(curated.map((app) => app.slug))
  const apps = [...curated, ...found.filter((app) => !seen.has(app.slug))]
  if (apps.length > 0) {
    return <ComposioGroup apps={apps} view={view} actions={actions} divided={divided} />
  }
  if (divided) {
    return null
  }
  return listing.status === 'loading' ? (
    <p role="status" className="px-2 py-3 text-xs text-muted-foreground">
      {t('bots.composio.loading', 'Reading Composio’s apps…')}
    </p>
  ) : (
    <>{empty}</>
  )
}

function ComposioGroup({
  apps,
  view,
  actions,
  divided
}: {
  apps: ComposioPick[]
  view: ComposioBotView
  actions: ComposioActions
  divided: boolean
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <section
      aria-label={t('bots.apps.composio.withComposio', 'With Composio')}
      data-divided={divided}
      className="data-[divided=true]:mt-3.5 data-[divided=true]:border-t data-[divided=true]:border-border data-[divided=true]:pt-1"
    >
      <BotAppCaption
        title={t('bots.apps.composio.withComposio', 'With Composio')}
        count={apps.length}
      />
      <ul className="flex flex-col">
        {apps.map((app) => (
          <ComposioAppItem key={app.slug} app={app} view={view} actions={actions} />
        ))}
      </ul>
    </section>
  )
}
