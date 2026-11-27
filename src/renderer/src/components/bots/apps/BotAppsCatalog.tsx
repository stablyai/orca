// Add apps' body: the header, the search, the chips and the list they filter, or the step an Add opened.
import React, { useCallback, useRef, useState } from 'react'
import { Plus } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import type { Bot } from '../../../../../shared/bot-types'
import { COMPOSIO_PAGES } from '../../../../../shared/composio/composio-apps'
import { composioAppName } from '../../../../../shared/composio/composio-curated-apps'
import { type BotConnector, useBotConnectorState } from '../bot-connectors'
import { botToolErrorMessage } from '../bot-tools-client'
import { useBotTools } from '../bot-tool-checks'
import {
  addComposioTool,
  connectComposioApp,
  openComposioPage,
  readComposioApp,
  useComposioBot
} from '../composio/composio-client'
import { ComposioSignInWait } from '../composio/ComposioSignInWait'
import { composioKeyScopeOf, type ComposioKeyScope } from '../composio/composio-key-client'
import { askBotInChat } from '../webhooks/ask-bot-in-chat'
import { webhookSetUpDraft } from '../webhooks/use-webhooks-connector'
import {
  BOT_APP_CATEGORIES,
  botAppCategoryName,
  DIRECT_APPS,
  type BotAppCategory,
  type BotDirectApp
} from './bot-app-catalog'
import { BotAppBrandLogo } from './BotAppBrandLogo'
import { BotAppStepHeader } from './BotAppStepParts'
import { ComposioAccountStep, WebhooksStep } from './BotAppSteps'
import { CustomAppStep } from './BotAppUrlStep'
import { composioSignedIn, type ComposioActions, type ComposioPick } from './BotAppComposio'
import { BotAppsAddedButton, type BotAddedSources } from './BotAppsAdded'
import { BotAppsChips, type BotAppsView } from './BotAppsChips'
import { BotAppsList } from './BotAppsList'
import { AppsCatalogFrame } from './AppsCatalogFrame'
import { BotAppsNoMatch, DirectAppRow, useCustomApps, type DirectRow } from './BotAppsRows'
import { botMcpAppUrlTag } from '../../../../../shared/bots/bot-mcp-apps'
import { botToolApps } from './bot-tool-apps'
import { botMcpAppLine } from '../../../../../shared/bots/bot-app-lines'

/** Where Add leads when it isn't Orca's own connector setup, which opens in its own dialog. */
export type BotAppsStep =
  | { kind: 'webhooks' }
  | { kind: 'mcp'; app: Extract<BotDirectApp, { route: 'mcp' }> }
  | { kind: 'custom' }
  | { kind: 'composio-account'; app?: ComposioPick; replacing?: ComposioKeyScope }
  | {
      kind: 'composio-wait'
      app: ComposioPick
      attempt: number
      error: string | null
      keyScope?: ComposioKeyScope | null
    }

/** Mounted only while the dialog shows, so each opening starts on All apps with an empty search. */
export function BotAppsCatalog({
  bot,
  title,
  onOpenChange,
  onManage,
  onAdd,
  step,
  setStep
}: {
  bot: Bot
  title: string
  onOpenChange: (open: boolean) => void
  /** Closes the dialog for the bot's Connectors tab, where every app it has is a row. */
  onManage: () => void
  onAdd: (connector: BotConnector['id']) => void
  step: BotAppsStep | null
  setStep: (step: BotAppsStep | null) => void
}): React.JSX.Element {
  const t = useTranslate()
  const state = useBotConnectorState(bot)
  const composio = useComposioBot(bot)
  const [view, setView] = useState<BotAppsView>('all')
  const [query, setQuery] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const switchView = (next: BotAppsView): void => {
    if (listRef.current) {
      listRef.current.scrollTop = 0
    }
    setView(next)
  }
  const close = useCallback(() => onOpenChange(false), [onOpenChange])
  const manage = onManage
  const webhooks = state.catalog.find((connector) => connector.id === 'webhooks')
  // Which apps the bot has, from its tools alone: no check starts its servers.
  const toolApps = botToolApps(useBotTools(bot, 'none').view)
  // A connector shows once it can be added or when the bot already has it.
  const direct: DirectRow[] = DIRECT_APPS.flatMap((app): DirectRow[] => {
    if (app.route === 'mcp') {
      const tool = toolApps.find((entry) => entry.app?.id === app.id)?.tool
      const tag = tool && botMcpAppUrlTag(app, tool.detail)
      return [{ app, name: app.name, added: tool !== undefined, tag: tag ?? undefined }]
    }
    const connector = state.catalog.find((entry) => entry.id === app.connector)
    if (!connector) {
      return []
    }
    const added = state.added(connector)
    return added || state.available(connector)
      ? [{ app, connector, name: connector.label, added }]
      : []
  })
  const signedIn = composioSignedIn(composio)
  const mineDirect = direct.filter((row) => row.added)
  const byUrl = toolApps.filter((entry) => entry.app === null)
  const webhooksAdded = webhooks !== undefined && state.added(webhooks)
  const categories = BOT_APP_CATEGORIES.filter((category) =>
    direct.some((row) => row.app.category === category)
  )
  const custom = useCustomApps(
    !webhooks || !state.available(webhooks) ? 'off' : webhooksAdded ? 'added' : 'available'
  )

  const connectComposio = (app: ComposioPick, attempt: number): void => {
    setStep({ kind: 'composio-wait', app, attempt, error: null })
    void connectComposioApp(bot, app.slug).catch((error: unknown) =>
      setStep({
        kind: 'composio-wait',
        app,
        attempt,
        error: botToolErrorMessage(error),
        keyScope: composioKeyScopeOf(error)
      })
    )
  }
  // How an app signs in is the host's record of it, whichever list the row came from.
  const addComposio = async (app: ComposioPick, keyOk: boolean): Promise<void> => {
    if (!keyOk) {
      setStep({ kind: 'composio-account', app })
      return
    }
    const signIn = app.signIn ?? (await readComposioApp(bot, app.slug)).signIn
    if (signIn === 'own') {
      openComposioPage(COMPOSIO_PAGES.authConfigs)
    } else if (signIn === 'none') {
      await addComposioTool(bot)
      manage()
    } else {
      connectComposio(app, 1)
    }
  }
  const startComposio = (app: ComposioPick, keyOk: boolean): void => {
    void addComposio(app, keyOk).catch((error: unknown) => toast.error(botToolErrorMessage(error)))
  }
  const composioActions: ComposioActions = {
    add: (app) => startComposio(app, composio.status?.key === 'ok'),
    resume: (app) => setStep({ kind: 'composio-wait', app, attempt: 0, error: null }),
    manage
  }
  const browseAll = (): void => {
    setQuery('')
    if (composio.status?.key === 'ok') {
      switchView('catalog')
    } else {
      setStep({ kind: 'composio-account' })
    }
  }
  const back = (): void => setStep(null)

  if (step?.kind === 'webhooks') {
    return (
      <WebhooksStep
        bot={bot}
        onBack={back}
        onClose={close}
        onSetUp={() => {
          close()
          askBotInChat(bot, webhookSetUpDraft())
        }}
      />
    )
  }
  if (step?.kind === 'mcp') {
    const { app } = step
    return (
      <CustomAppStep
        bot={bot}
        preset={{
          name: app.id,
          title: app.name,
          line: botMcpAppLine(app, t),
          url: app.url,
          variable: app.variable,
          logo: <BotAppBrandLogo app={app} size="lg" />
        }}
        onBack={back}
        onClose={close}
        onManage={manage}
      />
    )
  }
  if (step?.kind === 'custom') {
    return <CustomAppStep bot={bot} onBack={back} onClose={close} onManage={manage} />
  }
  if (step?.kind === 'composio-account') {
    const { app } = step
    return (
      <ComposioAccountStep
        bot={bot}
        appName={app?.name}
        replacing={step.replacing}
        onBack={back}
        onClose={close}
        onSaved={async () => {
          if (app) {
            await addComposio(app, true)
            return
          }
          setStep(null)
          setView('catalog')
        }}
      />
    )
  }
  if (step?.kind === 'composio-wait') {
    const { app, attempt, keyScope } = step
    return (
      <>
        <BotAppStepHeader onBack={back} onClose={close} />
        <ComposioSignInWait
          key={attempt}
          bot={bot}
          app={app}
          connectError={step.error}
          onDone={manage}
          onRetry={() => connectComposio(app, attempt + 1)}
          onChangeKey={
            keyScope
              ? () => setStep({ kind: 'composio-account', app, replacing: keyScope })
              : undefined
          }
          onClose={close}
        />
      </>
    )
  }

  const directRow = (row: DirectRow): React.JSX.Element => (
    <DirectAppRow
      key={row.name}
      bot={bot}
      row={row}
      onAdd={(picked) =>
        'connector' in picked
          ? onAdd(picked.connector.id)
          : setStep({ kind: 'mcp', app: picked.app })
      }
      onAnother={onAdd}
      onManage={manage}
    />
  )
  const added: BotAddedSources = {
    direct: mineDirect,
    byUrl,
    webhooks: webhooksAdded,
    composio: [...signedIn].map(([slug, label]) => ({
      slug,
      name: composioAppName(
        slug,
        composio.connections?.connections.find((entry) => entry.app === slug)?.name
      ),
      line: label ?? ''
    }))
  }
  const addByUrl = (): void => setStep({ kind: 'custom' })
  const noMatch = (where: 'all' | 'mine' | BotAppCategory): React.JSX.Element => (
    <BotAppsNoMatch
      where={where}
      query={query}
      botName={bot.name}
      onClear={() => {
        setQuery('')
        searchRef.current?.focus()
      }}
      onSearchAll={() => {
        switchView('all')
        searchRef.current?.focus()
      }}
      onAddByUrl={addByUrl}
    />
  )
  const pickView = (next: BotAppsView): void => {
    switchView(next)
    setQuery('')
  }
  const searchLabel =
    view === 'catalog'
      ? t('bots.apps.searchComposio', 'Search Composio apps')
      : view === 'mine'
        ? t('bots.apps.searchAdded', 'Search added apps')
        : t('bots.apps.search', 'Search apps')
  return (
    <AppsCatalogFrame
      title={title}
      added={
        <BotAppsAddedButton
          sources={added}
          pressed={view === 'mine'}
          onToggle={() => pickView(view === 'mine' ? 'all' : 'mine')}
        />
      }
      onClose={close}
      query={query}
      onQuery={setQuery}
      searchLabel={searchLabel}
      searchRef={searchRef}
      custom={
        <Button variant="outline" className="h-9.5 max-w-1/2" onClick={addByUrl}>
          <Plus />
          <span className="truncate">{t('bots.apps.addByUrl', 'Add by URL')}</span>
        </Button>
      }
      chips={
        <BotAppsChips
          view={view}
          onView={pickView}
          categories={categories}
          categoryName={botAppCategoryName}
        />
      }
      listRef={listRef}
    >
      <BotAppsList
        bot={bot}
        view={view}
        query={query}
        direct={direct}
        renderDirect={directRow}
        custom={custom}
        onCustom={(id) => setStep({ kind: id === 'url' ? 'custom' : 'webhooks' })}
        added={added}
        onManage={manage}
        composio={composio}
        composioActions={composioActions}
        onBrowseAll={browseAll}
        noMatch={noMatch}
      />
    </AppsCatalogFrame>
  )
}
