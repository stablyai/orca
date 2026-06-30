import { BellRing } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import type { UnreadBadgeContributor } from '@/lib/unread-badge-count'
import { getUnreadBadgeModel } from '@/lib/unread-badge-count'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { Button } from '../ui/button'

function getUnreadBadgeContributorTitle(contributor: UnreadBadgeContributor): string {
  return contributor.worktreeLabel
}

function getUnreadBadgeContributorSummary(contributor: UnreadBadgeContributor): string {
  const parts: string[] = []
  if (contributor.unreadWorktree) {
    parts.push(
      translate('auto.components.settings.UnreadBadgeSection.53e91d09bb', 'Unread workspace')
    )
  }
  if (contributor.unreadTabTitles.length === 1) {
    parts.push(
      translate('auto.components.settings.UnreadBadgeSection.5a73ceaf0b', 'Unread tab: {{title}}', {
        title: contributor.unreadTabTitles[0]
      })
    )
  } else if (contributor.unreadTabTitles.length > 1) {
    parts.push(
      translate(
        'auto.components.settings.UnreadBadgeSection.26989de033',
        'Unread tabs: {{titles}}',
        { titles: contributor.unreadTabTitles.join(', ') }
      )
    )
  }
  return parts.join('; ')
}

export function UnreadBadgeSection(): React.JSX.Element {
  const unreadBadgeInputs = useAppStore(
    useShallow((state) => ({
      worktreesByRepo: state.worktreesByRepo,
      tabsByWorktree: state.tabsByWorktree,
      unreadTerminalTabs: state.unreadTerminalTabs
    }))
  )
  const unreadBadgeModel = getUnreadBadgeModel(unreadBadgeInputs)

  const handleOpenUnreadBadgeContributor = (contributor: UnreadBadgeContributor): void => {
    if (!contributor.worktreeId) {
      return
    }
    const store = useAppStore.getState()
    store.setActiveWorktree(contributor.worktreeId)
    store.revealWorktreeInSidebar(contributor.worktreeId)
    const firstUnreadTabId = contributor.unreadTabIds[0]
    if (firstUnreadTabId) {
      store.setActiveTab(firstUnreadTabId)
    }
  }

  const handleClearUnreadBadgeContributor = (contributor: UnreadBadgeContributor): void => {
    const store = useAppStore.getState()
    if (contributor.worktreeId && contributor.unreadWorktree) {
      store.clearWorktreeUnread(contributor.worktreeId)
    }
    for (const tabId of contributor.unreadTabIds) {
      store.clearTerminalTabUnread(tabId)
    }
  }

  return (
    <section className="space-y-3 pt-3" aria-labelledby="app-badge-heading">
      <div className="flex min-w-0 items-center gap-2">
        <BellRing className="size-4 text-muted-foreground" />
        <div className="min-w-0">
          <h3 id="app-badge-heading" className="text-sm font-medium">
            {translate('auto.components.settings.UnreadBadgeSection.6fe9e761d4', 'App Badge')}
          </h3>
          <p className="text-xs text-muted-foreground">
            {unreadBadgeModel.count > 0
              ? translate(
                  'auto.components.settings.UnreadBadgeSection.5c03b21b7f',
                  '{{count}} worktrees or tabs currently contribute to the app badge.',
                  { count: unreadBadgeModel.count }
                )
              : translate(
                  'auto.components.settings.UnreadBadgeSection.90303c42ae',
                  'No worktrees or tabs currently contribute to the app badge.'
                )}
          </p>
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.UnreadBadgeSection.10f410d6ba',
              'Recent notifications below are separate from the app badge.'
            )}
          </p>
        </div>
      </div>

      <div className="space-y-2">
        {unreadBadgeModel.contributors.length > 0 ? (
          unreadBadgeModel.contributors.map((contributor) => {
            const title = getUnreadBadgeContributorTitle(contributor)
            return (
              <article
                key={contributor.id}
                className="rounded-md border border-border bg-card px-3 py-2 text-card-foreground"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 space-y-1">
                    <h4 className="truncate text-sm font-medium">{title}</h4>
                    {contributor.repoLabel ? (
                      <p className="text-[11px] text-muted-foreground">{contributor.repoLabel}</p>
                    ) : null}
                    <p className="text-xs text-muted-foreground">
                      {getUnreadBadgeContributorSummary(contributor)}
                    </p>
                  </div>

                  <div className="flex shrink-0 flex-wrap items-center gap-2">
                    {contributor.worktreeId ? (
                      <Button
                        variant="outline"
                        size="xs"
                        className="gap-1.5"
                        aria-label={translate(
                          'auto.components.settings.UnreadBadgeSection.4c9ec08e01',
                          'Open {{title}}',
                          { title }
                        )}
                        onClick={() => handleOpenUnreadBadgeContributor(contributor)}
                      >
                        {translate(
                          'auto.components.settings.UnreadBadgeSection.76e749949a',
                          'Open'
                        )}
                      </Button>
                    ) : null}
                    <Button
                      variant="outline"
                      size="xs"
                      className="gap-1.5"
                      aria-label={translate(
                        'auto.components.settings.UnreadBadgeSection.763de330f5',
                        'Mark {{title}} read',
                        { title }
                      )}
                      onClick={() => handleClearUnreadBadgeContributor(contributor)}
                    >
                      {translate(
                        'auto.components.settings.UnreadBadgeSection.d34c17d177',
                        'Mark Read'
                      )}
                    </Button>
                  </div>
                </div>
              </article>
            )
          })
        ) : (
          <div className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.UnreadBadgeSection.3c36cecbda',
              'No unread worktrees or terminal tabs'
            )}
          </div>
        )}
      </div>
    </section>
  )
}
