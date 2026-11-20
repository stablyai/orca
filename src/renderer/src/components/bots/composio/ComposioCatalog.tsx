// The bot's Composio app list in its Tools: Composio's apps by use, searched on Composio's side, each
// with its own Connect, and the bot's sign-ins first. Read by the bots' host with the owner's key.
import React, { useEffect, useRef, useState } from 'react'
import { type BotRef, useStableBotRef } from '@/lib/bot-hosts'
import { ExternalLink, Search } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { translate } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import { botToolErrorMessage } from '../bot-tools-client'
import {
  COMPOSIO_PAGES,
  type ComposioApp,
  type ComposioConnection,
  type ComposioPendingConnect
} from '../../../../../shared/composio/composio-apps'
import { composioAppName } from '../../../../../shared/composio/composio-curated-apps'
import { ComposioAppLogo } from './ComposioAppLogo'
import {
  addComposioTool,
  cancelComposioConnect,
  connectComposioApp,
  disconnectComposioApp,
  openComposioPage,
  readComposioApps,
  type ComposioBotView
} from './composio-client'

const SEARCH_DELAY_MS = 250
const FIRST_LOOK = 6

type Page = { apps: ComposioApp[]; nextCursor: string | null }
type Listing =
  | { status: 'loading' }
  | { status: 'ready'; page: Page; more: boolean }
  | { status: 'error'; message: string }

/** Composio's apps for a search, a page at a time; a newer search drops an older answer. */
export function useComposioApps(listed: BotRef, search: string, attempt: number) {
  const bot = useStableBotRef(listed)
  const [listing, setListing] = useState<Listing>({ status: 'loading' })
  const ticket = useRef(0)
  useEffect(() => {
    const mine = (ticket.current += 1)
    setListing({ status: 'loading' })
    const timer = setTimeout(
      () => {
        void readComposioApps(bot, { search }).then(
          (page) => ticket.current === mine && setListing({ status: 'ready', page, more: false }),
          (error: unknown) =>
            ticket.current === mine &&
            setListing({ status: 'error', message: botToolErrorMessage(error) })
        )
      },
      search ? SEARCH_DELAY_MS : 0
    )
    return () => clearTimeout(timer)
  }, [bot, search, attempt])
  const showMore = () => {
    if (listing.status !== 'ready' || !listing.page.nextCursor || listing.more) {
      return
    }
    const mine = ticket.current
    const before = listing.page
    setListing({ status: 'ready', page: before, more: true })
    void readComposioApps(bot, { search, cursor: before.nextCursor ?? undefined }).then(
      (next) =>
        ticket.current === mine &&
        setListing({
          status: 'ready',
          page: { apps: [...before.apps, ...next.apps], nextCursor: next.nextCursor },
          more: false
        }),
      (error: unknown) => {
        if (ticket.current === mine) {
          setListing({ status: 'ready', page: before, more: false })
          toast.error(botToolErrorMessage(error))
        }
      }
    )
  }
  return { listing, showMore }
}

function AppRow({
  slug,
  name,
  logo,
  line,
  children
}: {
  slug: string
  name: string
  logo?: string | null
  line: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <li className="flex min-h-13 items-center gap-3 border-b border-border py-2 last:border-b-0">
      <ComposioAppLogo slug={slug} logo={logo} size="md" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-foreground">{name}</span>
        <span className="block truncate text-xs text-muted-foreground">{line}</span>
      </span>
      <span className="flex shrink-0 items-center gap-1">{children}</span>
    </li>
  )
}

type CatalogRowProps = {
  bot: BotRef
  app: { slug: string; name: string; description?: string; signIn?: ComposioApp['signIn'] }
  logo?: string | null
  /** The bot has its Composio tool. */
  added: boolean
  connection: ComposioConnection | undefined
  pending: ComposioPendingConnect | undefined
}

/** One app's line and actions, from the bot's sign-in to it (if any) and a Connect under way. */
function appActions({ bot, app, added, connection, pending }: CatalogRowProps): {
  line: string
  actions: React.ReactNode
} {
  const run = (action: () => Promise<unknown>) =>
    void action().catch((error: unknown) => toast.error(botToolErrorMessage(error)))
  const connect = () => run(() => connectComposioApp(bot, app.slug))
  if (pending) {
    return {
      line: translate(
        'bots.composio.connecting',
        'Waiting for you to finish signing in, in your browser'
      ),
      actions: (
        <>
          <Button size="xs" variant="ghost" onClick={() => openComposioPage(pending.url)}>
            {translate('bots.composio.openAgain', 'Open again')}
          </Button>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => run(() => cancelComposioConnect(bot, app.slug))}
          >
            {translate('bots.composio.cancel', 'Cancel')}
          </Button>
        </>
      )
    }
  }
  if (connection) {
    const working = connection.status === 'active'
    return {
      line: working
        ? connection.label
          ? translate('bots.composio.connectedAs', 'Connected as {{label}}', {
              label: connection.label
            })
          : translate('bots.composio.connected', 'Connected')
        : connection.label
          ? translate('bots.composio.signInAgainAs', 'Needs you to sign in again · {{label}}', {
              label: connection.label
            })
          : translate('bots.composio.signInAgain', 'Needs you to sign in again'),
      actions: (
        <>
          <Button size="xs" variant={working ? 'ghost' : 'outline'} onClick={connect}>
            {translate('bots.composio.reconnect', 'Reconnect')}
          </Button>
          {working ? (
            <Button
              size="xs"
              variant="ghost"
              aria-label={translate('bots.composio.disconnectNamed', 'Disconnect {{app}}', {
                app: app.name
              })}
              onClick={() => run(() => disconnectComposioApp(bot, connection.id))}
            >
              {translate('bots.composio.disconnect', 'Disconnect')}
            </Button>
          ) : null}
        </>
      )
    }
  }
  if (app.signIn === 'own') {
    return {
      line: translate('bots.composio.ownDeveloperApp', 'Needs your own {{app}} developer app', {
        app: app.name
      }),
      actions: (
        <Button
          size="xs"
          variant="ghost"
          onClick={() => openComposioPage(COMPOSIO_PAGES.authConfigs)}
        >
          {translate('bots.composio.setUpInComposio', 'Set up in Composio')}
          <ExternalLink />
        </Button>
      )
    }
  }
  if (app.signIn === 'none') {
    // Nothing to sign in to: the bot can use it as soon as it has its Composio tool.
    return added
      ? {
          line: translate('bots.composio.readyNoSignIn', 'Ready · no sign-in needed'),
          actions: null
        }
      : {
          line: translate('bots.composio.noSignInNeeded', 'No sign-in needed'),
          actions: (
            <Button size="xs" variant="outline" onClick={() => run(() => addComposioTool(bot))}>
              {translate('bots.composio.addTool', 'Add')}
            </Button>
          )
        }
  }
  return {
    line:
      app.signIn === 'key'
        ? translate('bots.composio.apiKeyLine', '{{line}} · signs in with your API key', {
            line: app.description ?? app.name
          })
        : (app.description ?? ''),
    actions: (
      <Button
        size="xs"
        variant="outline"
        aria-label={translate('bots.composio.connectNamed', 'Connect {{app}}', { app: app.name })}
        onClick={connect}
      >
        {translate('bots.composio.connect', 'Connect')}
      </Button>
    )
  }
}

function CatalogRow(props: CatalogRowProps): React.JSX.Element {
  const { line, actions } = appActions(props)
  return (
    <AppRow slug={props.app.slug} name={props.app.name} logo={props.logo} line={line}>
      {actions}
    </AppRow>
  )
}

export function ComposioCatalog({
  bot,
  botName,
  view,
  focusSearch
}: {
  bot: BotRef
  botName: string
  view: ComposioBotView
  focusSearch: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<'all' | 'connected'>('all')
  const [attempt, setAttempt] = useState(0)
  const [expanded, setExpanded] = useState(false)
  const search = query.trim()
  const { listing, showMore } = useComposioApps(bot, filter === 'all' ? search : '', attempt)
  const connections = view.connections?.connections ?? []
  const pending = view.connections?.pending ?? []
  const added = view.status?.added ?? false
  const connectionOf = (slug: string) =>
    connections.find((entry) => entry.app === slug && entry.status === 'active') ??
    connections.find((entry) => entry.app === slug)
  const pendingOf = (slug: string) => pending.find((entry) => entry.app === slug)
  const matches = (name: string) => name.toLocaleLowerCase().includes(search.toLocaleLowerCase())
  // One row per app the bot has signed in to, its working sign-in first.
  const signedIn = [...new Set(connections.map((entry) => entry.app))]
    .map((slug) => ({ slug, connection: connectionOf(slug) }))
    .filter((entry) => matches(composioAppName(entry.slug, entry.connection?.name)))
  const searchLabel = t('bots.composio.search', 'Search Composio’s apps')
  const others =
    filter === 'all' && listing.status === 'ready'
      ? listing.page.apps.filter((app) => !connectionOf(app.slug))
      : []
  // A short first look, the bot's own apps first; a search, or Show more, lists everything.
  const room = search || expanded ? Infinity : Math.max(FIRST_LOOK - signedIn.length, 0)
  const hidden = others.length > room
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="text"
            value={query}
            autoFocus={focusSearch}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={searchLabel}
            aria-label={searchLabel}
            inset="leadingIcon"
            className="h-8"
          />
        </div>
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          value={filter}
          onValueChange={(value) => {
            if (value === 'all' || value === 'connected') {
              setFilter(value)
            }
          }}
        >
          <ToggleGroupItem value="all">{t('bots.composio.filterAll', 'All')}</ToggleGroupItem>
          <ToggleGroupItem value="connected">
            {t('bots.composio.filterConnected', 'Connected {{count}}', {
              count: new Set(
                connections.filter((entry) => entry.status === 'active').map((entry) => entry.app)
              ).size
            })}
          </ToggleGroupItem>
        </ToggleGroup>
      </div>
      {view.error ? (
        <p className="text-xs text-muted-foreground">
          {t('bots.composio.signInsUnread', 'Couldn’t read {{bot}}’s sign-ins. {{error}}', {
            bot: botName,
            error: view.error
          })}
        </p>
      ) : null}
      <ul className="flex flex-col">
        {signedIn.map(({ slug, connection }) => (
          <CatalogRow
            key={`signed-in:${slug}`}
            bot={bot}
            app={{ slug, name: composioAppName(slug, connection?.name) }}
            added={added}
            connection={connection}
            pending={pendingOf(slug)}
          />
        ))}
        {others.slice(0, room).map((app) => (
          <CatalogRow
            key={app.slug}
            bot={bot}
            app={app}
            logo={app.logo}
            added={added}
            connection={undefined}
            pending={pendingOf(app.slug)}
          />
        ))}
      </ul>
      {filter === 'all' && listing.status === 'loading' ? (
        <p role="status" className="py-2 text-xs text-muted-foreground">
          {t('bots.composio.loading', 'Reading Composio’s apps…')}
        </p>
      ) : null}
      {filter === 'all' && listing.status === 'error' ? (
        <div className="flex items-center gap-2 py-2 text-xs text-muted-foreground">
          <span>
            {t('bots.composio.unread', 'Couldn’t load Composio’s apps. {{error}}', {
              error: listing.message
            })}
          </span>
          <Button size="xs" variant="ghost" onClick={() => setAttempt((value) => value + 1)}>
            {t('bots.composio.checkAgain', 'Check again')}
          </Button>
        </div>
      ) : null}
      {filter === 'all' &&
      listing.status === 'ready' &&
      listing.page.apps.length === 0 &&
      search ? (
        <p className="py-2 text-xs text-muted-foreground">
          {t('bots.composio.noMatch', 'Composio has no app named “{{query}}”.', {
            query: search
          })}
        </p>
      ) : null}
      {filter === 'connected' && signedIn.length === 0 ? (
        <p className="py-2 text-xs text-muted-foreground">
          {t('bots.composio.noneConnected', '{{bot}} has no apps connected yet.', {
            bot: botName
          })}
        </p>
      ) : null}
      {filter === 'all' && listing.status === 'ready' && (hidden || listing.page.nextCursor) ? (
        <Button
          size="sm"
          variant="ghost"
          className="self-center"
          disabled={listing.more}
          onClick={() => (hidden ? setExpanded(true) : showMore())}
        >
          {t('bots.composio.showMore', 'Show more')}
        </Button>
      ) : null}
      <div className="flex flex-wrap items-center gap-1 border-t border-border pt-3">
        <p className="min-w-0 flex-1 text-xs text-muted-foreground">
          {t('bots.composio.footerApps', '{{bot}} connects its own apps.', {
            bot: botName
          })}
        </p>
        <Button size="xs" variant="ghost" onClick={() => openComposioPage(COMPOSIO_PAGES.users)}>
          {t('bots.composio.openComposio', 'Open Composio')}
          <ExternalLink />
        </Button>
      </div>
    </div>
  )
}
