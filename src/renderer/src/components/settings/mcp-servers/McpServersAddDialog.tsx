// Add an MCP server: the catalog bots use for apps, filtered by the same chips, then the step an Add
// opens (a site to pick, Custom server). A server that needs a sign-in goes on to its browser sign-in.
import React, { useRef, useState } from 'react'
import { Plus } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { useTranslate } from '@/i18n/use-translate'
import { AppsCatalogFrame } from '@/components/bots/apps/AppsCatalogFrame'
import { AppsAddedButton } from '@/components/bots/apps/BotAppsAdded'
import { BotAppsChips } from '@/components/bots/apps/BotAppsChips'
import { BotAppBrandLogo } from '@/components/bots/apps/BotAppBrandLogo'
import { BotToolLogo } from '@/components/bots/apps/BotToolAppRow'
import { BotAppOutcome, BotAppStepHeader } from '@/components/bots/apps/BotAppStepParts'
import { BotAppUrlVariableForm } from '@/components/bots/apps/BotAppUrlVariableForm'
import { botToolErrorMessage } from '@/components/bots/bot-tools-client'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type { BotToolServer } from '../../../../../shared/bot-tools'
import {
  MCP_SERVER_CATALOG,
  MCP_SERVER_CATALOG_CATEGORIES,
  type McpServerCatalogEntry
} from '../../../../../shared/mcp-servers/mcp-server-catalog'
import { addMcpServer, type McpServerView } from '@/runtime/mcp-servers/mcp-servers-client'
import {
  McpServersCatalog,
  mcpCatalogLine,
  mcpCategoryName,
  type McpCatalogView
} from './McpServersCatalog'
import { McpCustomServerStep } from './McpCustomServerStep'
import { mcpServerNeedsSignIn, mcpServerTitle } from './mcp-server-words'
import { showMcpServerChangeToast } from './mcp-server-change-toast'
import type { McpSignInServer } from './McpServerSignInDialog'

type Step =
  | { kind: 'custom'; initial?: BotToolServer }
  | { kind: 'variable'; entry: McpServerCatalogEntry }
  | { kind: 'adding'; entry: McpServerCatalogEntry }

/** The entry as Custom server starts it: its address, and the header its token goes in. */
function customStart(entry: McpServerCatalogEntry): BotToolServer {
  return {
    name: entry.id,
    url: entry.url,
    headers: Object.fromEntries((entry.headers ?? []).map((row) => [row.key, row.value]))
  }
}

function Catalog({
  servers,
  onAdd,
  onCustom,
  onManage,
  onClose
}: {
  servers: readonly McpServerView[]
  onAdd: (entry: McpServerCatalogEntry) => void
  onCustom: () => void
  onManage: (server: McpServerView) => void
  onClose: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const [view, setView] = useState<McpCatalogView>('all')
  const [query, setQuery] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const pick = (next: McpCatalogView): void => {
    listRef.current?.scrollTo({ top: 0 })
    setView(next)
    setQuery('')
  }
  const categories = MCP_SERVER_CATALOG_CATEGORIES.filter((category) =>
    MCP_SERVER_CATALOG.some((entry) => entry.category === category)
  )
  const noMatch = (
    <div className="flex flex-col items-center gap-3.5 px-3 pt-12 pb-3 text-center text-sm text-muted-foreground">
      {t('settings.mcpServers.catalog.noMatch', 'No server matches “{{query}}”.', {
        query: query.trim()
      })}
      <Button variant="outline" size="sm" onClick={onCustom}>
        <Plus />
        {t('settings.mcpServers.custom.title', 'Custom server')}
      </Button>
    </div>
  )
  return (
    <AppsCatalogFrame
      title={t('settings.mcpServers.add.title', 'Add an MCP server')}
      added={
        <AppsAddedButton
          faces={servers.map((server) => ({
            key: server.id,
            logo: <BotToolLogo name={server.name} detail={server.detail} size="sm" />
          }))}
          pressed={view === 'mine'}
          onToggle={() => pick(view === 'mine' ? 'all' : 'mine')}
        />
      }
      onClose={onClose}
      query={query}
      onQuery={setQuery}
      searchLabel={t('settings.mcpServers.catalog.search', 'Search servers')}
      searchRef={searchRef}
      custom={
        <Button variant="outline" className="h-9.5 max-w-1/2" onClick={onCustom}>
          <Plus />
          <span className="truncate">{t('settings.mcpServers.custom.title', 'Custom server')}</span>
        </Button>
      }
      chips={
        <BotAppsChips
          view={view}
          onView={pick}
          categories={categories}
          categoryName={(category) => mcpCategoryName(category, t)}
          composio={false}
        />
      }
      listRef={listRef}
    >
      <McpServersCatalog
        view={view}
        query={query}
        entries={MCP_SERVER_CATALOG}
        servers={servers}
        onAdd={onAdd}
        onCustom={onCustom}
        onManage={onManage}
        noMatch={noMatch}
      />
    </AppsCatalogFrame>
  )
}

export function McpServersAddDialog({
  target,
  servers,
  open,
  onOpenChange,
  onSignIn,
  onManage
}: {
  target: RuntimeClientTarget
  servers: readonly McpServerView[]
  open: boolean
  onOpenChange: (open: boolean) => void
  onSignIn: (server: McpSignInServer) => void
  onManage: (server: McpServerView) => void
}): React.JSX.Element {
  const t = useTranslate()
  const [step, setStep] = useState<Step | null>(null)
  // Each opening's adds answer only that opening: one from before a close must not close or reset a later one.
  const opening = useRef(0)
  const close = (): void => {
    opening.current += 1
    onOpenChange(false)
    setStep(null)
  }
  /** After an add: on to its sign-in when Orca signs in to it, else done. */
  const added = (server: McpServerView): void => {
    close()
    if (mcpServerNeedsSignIn(server)) {
      onSignIn({ id: server.id, name: server.name, detail: server.detail })
      return
    }
    void showMcpServerChangeToast(
      target,
      t('settings.mcpServers.toast.added', '{{name}} added', { name: mcpServerTitle(server.name) })
    )
  }
  const addEntry = (entry: McpServerCatalogEntry, url: string): void => {
    setStep({ kind: 'adding', entry })
    const asked = opening.current
    void addMcpServer(target, { source: url, name: entry.id }).then(
      (server) => (opening.current === asked ? added(server) : undefined),
      (error: unknown) => {
        toast.error(botToolErrorMessage(error))
        if (opening.current === asked) {
          setStep(null)
        }
      }
    )
  }
  const pickEntry = (entry: McpServerCatalogEntry): void => {
    if (entry.headers) {
      setStep({ kind: 'custom', initial: customStart(entry) })
    } else if (entry.variable) {
      setStep({ kind: 'variable', entry })
    } else {
      addEntry(entry, entry.url)
    }
  }
  const title = t('settings.mcpServers.add.title', 'Add an MCP server')
  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent
        size="flush"
        showCloseButton={false}
        aria-describedby={undefined}
        data-step={step !== null}
        data-form={step?.kind === 'custom'}
        className="flex h-175 max-h-[calc(100vh-4rem)] flex-col overflow-hidden sm:max-w-[min(57.5rem,calc(100vw-4rem))] data-[step=true]:h-auto data-[step=true]:sm:max-w-115 data-[form=true]:sm:max-w-120"
      >
        {step?.kind === 'custom' ? (
          <McpCustomServerStep
            target={target}
            servers={servers}
            initial={step.initial}
            onAdded={(server) => (server ? added(server) : close())}
            onCancel={() => setStep(null)}
          />
        ) : step?.kind === 'variable' ? (
          <>
            <DialogTitle className="sr-only">{title}</DialogTitle>
            <BotAppStepHeader onBack={() => setStep(null)} onClose={close} />
            <BotAppUrlVariableForm
              className="px-6 pt-1 pb-6"
              app={{
                name: step.entry.id,
                title: step.entry.name,
                line: mcpCatalogLine(step.entry, t),
                url: step.entry.url,
                variable: step.entry.variable,
                logo: <BotAppBrandLogo app={step.entry} size="lg" />
              }}
              variable={step.entry.variable!}
              onAdd={(url) => addEntry(step.entry, url)}
            />
          </>
        ) : step?.kind === 'adding' ? (
          <>
            <DialogTitle className="sr-only">{title}</DialogTitle>
            <BotAppStepHeader onClose={close} />
            <BotAppOutcome
              logo={<BotAppBrandLogo app={step.entry} size="lg" />}
              title={t('bots.apps.mcp.adding', 'Adding {{app}}…', { app: step.entry.name })}
              line={null}
              actions={null}
            />
          </>
        ) : open ? (
          <Catalog
            servers={servers}
            onAdd={pickEntry}
            onCustom={() => setStep({ kind: 'custom' })}
            onManage={(server) => {
              close()
              onManage(server)
            }}
            onClose={close}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
