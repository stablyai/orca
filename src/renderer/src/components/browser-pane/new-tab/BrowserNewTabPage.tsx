import { useMemo } from 'react'
import { Globe } from 'lucide-react'
import { toast } from 'sonner'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store/index'
import { useRepoById } from '@/store/repos/use-repository-catalog'
import { useWorktreeById } from '@/store/workspaces/selection/use-selected-worktree'
import {
  prepareBrowserHistoryEntries,
  rankBrowserTopSites
} from '@/lib/browser/history/browser-history-match'
import { BrowserFavicon } from '@/components/browser-favicon'
import type { BrowserHistoryEntry } from '../../../../../shared/browser-workspace-types'
import type { Repo } from '../../../../../shared/repo-types'
import type { Worktree } from '../../../../../shared/worktree/types'
import type { WorkspaceLinkedItemRow } from '../../sidebar/workspace-card/review/workspace-hover-attachments'
import { BrowserNewTabTile } from './browser-new-tab-tile'
import { useBrowserNewTabLinkedItems } from './use-browser-new-tab-linked-items'
import { useBrowserNewTabServers, type BrowserNewTabServers } from './use-browser-new-tab-servers'
import { BrowserNewTabWorkspaceCard } from './browser-new-tab-workspace-card'
import { BrowserImportHintButton } from '../assemble-chrome/BrowserImportHintButton'
import { resolveWorktreeDisplayName } from '@/lib/workspace/display/worktree-default-display-name'
import { useWorktreeRuntimeTarget } from '@/runtime/rpc/targets/use-worktree-runtime-target'
import type { RuntimeClientTarget } from '../../../../../shared/runtime-client-target'

const SUGGESTED_TILE_LIMIT = 8
const NO_LINKED_ITEMS: WorkspaceLinkedItemRow[] = []

type BrowserNewTabServerContext = {
  servers: BrowserNewTabServers
  runtimeTarget: RuntimeClientTarget | null
  /** False when this tab's page runs on another machine than the workspace's ports. */
  openInPlace: boolean
}

export function BrowserNewTabPage({
  worktreeId,
  onOpenUrl,
  serversElsewhere = false,
  importProfileId
}: {
  worktreeId: string
  onOpenUrl: (url: string) => void
  /** This tab's page runs on another machine than the workspace's ports, so they open on theirs. */
  serversElsewhere?: boolean
  /** Local session profile to import logins into; omitted where the session isn't local. */
  importProfileId?: string | null
}): React.JSX.Element {
  const worktree = useWorktreeById(worktreeId)
  const repo = useRepoById(worktree?.repoId ?? null) ?? undefined
  const runtimeTarget = useWorktreeRuntimeTarget(worktreeId)
  const servers: BrowserNewTabServerContext = {
    servers: useBrowserNewTabServers(worktreeId, runtimeTarget),
    runtimeTarget,
    openInPlace: !serversElsewhere
  }
  return worktree ? (
    <BrowserNewTabWorktreePage
      worktree={worktree}
      repo={repo}
      servers={servers}
      onOpenUrl={onOpenUrl}
      importProfileId={importProfileId}
    />
  ) : (
    <BrowserNewTabPageLayout
      linkedItems={NO_LINKED_ITEMS}
      servers={servers}
      onOpenUrl={onOpenUrl}
      importProfileId={importProfileId}
    />
  )
}

function BrowserNewTabWorktreePage({
  worktree,
  repo,
  servers,
  onOpenUrl,
  importProfileId
}: {
  worktree: Worktree
  repo: Repo | undefined
  servers: BrowserNewTabServerContext
  onOpenUrl: (url: string) => void
  importProfileId?: string | null
}): React.JSX.Element {
  const linkedItems = useBrowserNewTabLinkedItems(worktree, repo)
  return (
    <BrowserNewTabPageLayout
      workspaceName={resolveWorktreeDisplayName(worktree)}
      linkedItems={linkedItems}
      servers={servers}
      onOpenUrl={onOpenUrl}
      importProfileId={importProfileId}
    />
  )
}

function BrowserNewTabPageLayout({
  workspaceName,
  linkedItems,
  servers: { servers, runtimeTarget, openInPlace },
  onOpenUrl,
  importProfileId
}: {
  workspaceName?: string
  linkedItems: WorkspaceLinkedItemRow[]
  servers: BrowserNewTabServerContext
  onOpenUrl: (url: string) => void
  importProfileId?: string | null
}): React.JSX.Element {
  const t = useTranslate()
  const browserUrlHistory = useAppStore((s) => s.browserUrlHistory)
  const removeBrowserHistoryEntry = useAppStore((s) => s.removeBrowserHistoryEntry)
  const restoreBrowserHistory = useAppStore((s) => s.restoreBrowserHistory)
  const suggested = useMemo(
    () =>
      rankBrowserTopSites({
        prepared: prepareBrowserHistoryEntries(browserUrlHistory),
        limit: SUGGESTED_TILE_LIMIT
      }),
    [browserUrlHistory]
  )
  const openableLinkedItems = linkedItems.filter((row) => row.url)
  const hasWorkspaceRows =
    Boolean(runtimeTarget && (servers.own.length > 0 || servers.others.length > 0)) ||
    openableLinkedItems.length > 0

  const removeSuggestion = (entry: BrowserHistoryEntry): void => {
    const removed = removeBrowserHistoryEntry(entry.normalizedUrl)
    if (!removed) {
      return
    }
    toast(
      t('browser.newTab.removedFromHistory', 'Removed “{{title}}” from history', {
        title: suggestionLabel(removed)
      }),
      {
        action: {
          label: t('browser.newTab.undo', 'Undo'),
          onClick: () =>
            restoreBrowserHistory({ browserUrlHistory: [removed], workspaceDocHistory: [] })
        }
      }
    )
  }

  // empty:hidden drops the row (and its flex gap) once the hint is hidden.
  const importRow =
    importProfileId === undefined ? null : (
      <div className="flex justify-center empty:hidden">
        <BrowserImportHintButton profileId={importProfileId} />
      </div>
    )

  if (!hasWorkspaceRows && suggested.length === 0) {
    return (
      <BrowserNewTabScroller>
        <div className="flex flex-col items-center gap-2.5 px-4 pt-16 text-center">
          <div className="mb-1.5 grid size-13 place-items-center rounded-full border border-border text-muted-foreground">
            <Globe className="size-5" />
          </div>
          <p className="text-base font-semibold text-foreground">
            {t('auto.components.browser.pane.BrowserPane.366bf5d62c', 'New Tab')}
          </p>
          <p className="max-w-sm text-sm leading-relaxed text-muted-foreground">
            {t(
              'browser.newTab.emptyHint',
              'Search or enter an address above. Sites you visit, dev servers running in this workspace, and its PR and issue will show up here.'
            )}
          </p>
        </div>
        {importRow}
      </BrowserNewTabScroller>
    )
  }

  return (
    <BrowserNewTabScroller>
      {hasWorkspaceRows ? (
        <BrowserNewTabSection
          label={t('browser.newTab.thisWorkspace', 'This workspace')}
          detail={workspaceName}
        >
          <BrowserNewTabWorkspaceCard
            servers={servers}
            linkedItems={openableLinkedItems}
            runtimeTarget={runtimeTarget}
            openServersInPlace={openInPlace}
            onOpenUrl={onOpenUrl}
          />
        </BrowserNewTabSection>
      ) : null}
      {suggested.length > 0 ? (
        <BrowserNewTabSection label={t('browser.newTab.suggested', 'Suggested')}>
          <BrowserNewTabTileGrid>
            {suggested.map((entry) => (
              <BrowserNewTabTile
                key={entry.normalizedUrl}
                icon={
                  <BrowserFavicon
                    faviconUrl={entry.faviconUrl}
                    className="size-8"
                    fallbackClassName="text-muted-foreground"
                  />
                }
                label={suggestionLabel(entry)}
                tooltip={entry.title.trim() ? `${entry.title} · ${entry.url}` : entry.url}
                onOpen={() => onOpenUrl(entry.url)}
                onRemove={() => removeSuggestion(entry)}
                removeLabel={t('browser.newTab.removeSuggestion', 'Remove from history')}
              />
            ))}
          </BrowserNewTabTileGrid>
        </BrowserNewTabSection>
      ) : null}
      {importRow}
    </BrowserNewTabScroller>
  )
}

function BrowserNewTabScroller({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="scrollbar-sleek @container absolute inset-0 z-10 overflow-y-auto bg-background">
      <div className="mx-auto flex max-w-[680px] flex-col gap-8 px-3 pt-14 pb-12 @xs:px-6">
        {children}
      </div>
    </div>
  )
}

function BrowserNewTabSection({
  label,
  detail,
  children
}: {
  label: string
  detail?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="flex min-w-0 gap-1.5 px-2 text-2xs text-muted-foreground">
        <span className="shrink-0 font-semibold tracking-[0.05em] uppercase">{label}</span>
        {detail ? (
          <>
            <span aria-hidden>·</span>
            <span className="truncate">{detail}</span>
          </>
        ) : null}
      </h2>
      {children}
    </section>
  )
}

function BrowserNewTabTileGrid({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="grid grid-cols-2 gap-2 @md:grid-cols-4">{children}</div>
}

function suggestionLabel(entry: BrowserHistoryEntry): string {
  if (entry.title.trim()) {
    return entry.title
  }
  try {
    return new URL(entry.url).host.replace(/^www\./, '')
  } catch {
    return entry.url
  }
}
