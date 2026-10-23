import { useMemo } from 'react'
import { Globe } from 'lucide-react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { useRepoById, useWorktreeById } from '@/store/selectors'
import { prepareBrowserHistoryEntries, rankBrowserTopSites } from '@/lib/browser-history-match'
import { BrowserFavicon } from '@/components/browser-favicon'
import type { BrowserHistoryEntry } from '../../../../../shared/browser-workspace-types'
import type { Repo } from '../../../../../shared/repo-types'
import type { Worktree } from '../../../../../shared/worktree/types'
import type { WorkspaceLinkedItemRow } from '../../sidebar/workspace-hover-attachments'
import { BrowserNewTabTile } from './browser-new-tab-tile'
import { useBrowserNewTabLinkedItems } from './use-browser-new-tab-linked-items'
import { useBrowserNewTabServers, type BrowserNewTabServers } from './use-browser-new-tab-servers'
import { BrowserNewTabWorkspaceCard } from './browser-new-tab-workspace-card'
import { useWorktreeRuntimeTarget } from '@/runtime/use-worktree-runtime-target'
import type { RuntimeClientTarget } from '../../../../../shared/runtime-client-target'

const SUGGESTED_TILE_LIMIT = 8
const NO_LINKED_ITEMS: WorkspaceLinkedItemRow[] = []

type BrowserNewTabServerContext = {
  servers: BrowserNewTabServers
  runtimeTarget: RuntimeClientTarget | null
  /** False when this tab's page runs on another machine than the workspace's ports. */
  openInPlace: boolean
}

/** The page a blank browser tab shows: this workspace's servers and links, then the sites you visit most. */
export function BrowserNewTabPage({
  worktreeId,
  onOpenUrl,
  serversElsewhere = false
}: {
  worktreeId: string
  onOpenUrl: (url: string) => void
  /** This tab's page runs on another machine than the workspace's ports, so they open on theirs. */
  serversElsewhere?: boolean
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
    />
  ) : (
    <BrowserNewTabPageLayout
      linkedItems={NO_LINKED_ITEMS}
      servers={servers}
      onOpenUrl={onOpenUrl}
    />
  )
}

function BrowserNewTabWorktreePage({
  worktree,
  repo,
  servers,
  onOpenUrl
}: {
  worktree: Worktree
  repo: Repo | undefined
  servers: BrowserNewTabServerContext
  onOpenUrl: (url: string) => void
}): React.JSX.Element {
  const linkedItems = useBrowserNewTabLinkedItems(worktree, repo)
  return (
    <BrowserNewTabPageLayout linkedItems={linkedItems} servers={servers} onOpenUrl={onOpenUrl} />
  )
}

function BrowserNewTabPageLayout({
  linkedItems,
  servers: { servers, runtimeTarget, openInPlace },
  onOpenUrl
}: {
  linkedItems: WorkspaceLinkedItemRow[]
  servers: BrowserNewTabServerContext
  onOpenUrl: (url: string) => void
}): React.JSX.Element {
  const browserUrlHistory = useAppStore((s) => s.browserUrlHistory)
  const removeBrowserHistoryEntry = useAppStore((s) => s.removeBrowserHistoryEntry)
  const restoreBrowserHistoryEntry = useAppStore((s) => s.restoreBrowserHistoryEntry)
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
      translate('browser.newTab.removedFromHistory', 'Removed “{{title}}” from history', {
        title: suggestionLabel(removed)
      }),
      {
        action: {
          label: translate('browser.newTab.undo', 'Undo'),
          onClick: () => restoreBrowserHistoryEntry(removed)
        }
      }
    )
  }

  if (!hasWorkspaceRows && suggested.length === 0) {
    return (
      <BrowserNewTabScroller>
        <div className="flex flex-col items-center gap-2.5 px-4 pt-16 text-center">
          <div className="mb-1.5 grid size-13 place-items-center rounded-full border border-border text-muted-foreground">
            <Globe className="size-5" />
          </div>
          <p className="text-base font-semibold text-foreground">
            {translate('auto.components.browser.pane.BrowserPane.366bf5d62c', 'New Tab')}
          </p>
          <p className="max-w-sm text-sm leading-relaxed text-muted-foreground">
            {translate(
              'browser.newTab.emptyHint',
              'Search or enter an address above. Sites you visit, dev servers running in this workspace, and its PR and issue will show up here.'
            )}
          </p>
        </div>
      </BrowserNewTabScroller>
    )
  }

  return (
    <BrowserNewTabScroller>
      {hasWorkspaceRows ? (
        <BrowserNewTabSection label={translate('browser.newTab.thisWorkspace', 'This workspace')}>
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
        <BrowserNewTabSection label={translate('browser.newTab.suggested', 'Suggested')}>
          <BrowserNewTabTileGrid>
            {suggested.map((entry) => (
              <BrowserNewTabTile
                key={entry.normalizedUrl}
                icon={
                  <BrowserFavicon
                    faviconUrl={entry.faviconUrl}
                    className="size-6"
                    fallbackClassName="size-5 text-muted-foreground"
                  />
                }
                label={suggestionLabel(entry)}
                tooltip={entry.title.trim() ? `${entry.title} · ${entry.url}` : entry.url}
                onOpen={() => onOpenUrl(entry.url)}
                onRemove={() => removeSuggestion(entry)}
                removeLabel={translate('browser.newTab.removeSuggestion', 'Remove from history')}
              />
            ))}
          </BrowserNewTabTileGrid>
        </BrowserNewTabSection>
      ) : null}
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
  children
}: {
  label: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="px-2 text-2xs font-semibold tracking-[0.05em] text-muted-foreground uppercase">
        {label}
      </h2>
      {children}
    </section>
  )
}

function BrowserNewTabTileGrid({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    // Why steps above the smallest panes: eight tiles land in full rows of 4 or 8.
    <div className="grid grid-cols-[repeat(auto-fill,minmax(4.25rem,1fr))] gap-1 @[20rem]:grid-cols-4 @[39rem]:grid-cols-8">
      {children}
    </div>
  )
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
