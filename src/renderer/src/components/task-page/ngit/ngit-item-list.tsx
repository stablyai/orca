import { ArrowRight, ExternalLink, FolderKanban, Plus } from 'lucide-react'
import { getWorktreeAttachmentLabel } from '@/lib/workspace/display/worktree-attachment-label'
import type { Worktree } from '../../../../../shared/worktree/types'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import { openAppHttpLink } from '@/lib/browser/navigation/app-http-link-open'
import { ngitShortId, type NgitWorkItem } from '../../../../../shared/ngit/ngit-work-item-types'
import { NgitStateIcon, ngitStateLabel, ngitTypeLabel } from './ngit-work-item-state'

const ROW_COLUMNS = 'grid-cols-[88px_minmax(0,3fr)_minmax(0,1fr)_120px_100px_150px]'

export function NgitItemList({
  items,
  loading,
  emptyTitle,
  emptyDescription,
  onOpen,
  workspaceOf,
  onUse,
  onStartNew
}: {
  items: NgitWorkItem[]
  loading: boolean
  emptyTitle: string
  emptyDescription: string
  onOpen: (item: NgitWorkItem) => void
  workspaceOf: (item: NgitWorkItem) => Worktree | null
  onUse: (item: NgitWorkItem) => void
  onStartNew: (item: NgitWorkItem) => void
}): React.JSX.Element {
  const t = useTranslate()
  const intlLocale = useIntlLocale()
  const startWorkspace = t('components.taskPage.ngit.startWorkspace', 'Start workspace')
  const startNew = t('auto.components.TaskPage.b6329379ca', 'Start new workspace')
  const openInBrowser = t('components.taskPage.ngit.openInBrowser', 'Open on gitworkshop.dev')
  return (
    <div className="flex min-h-0 max-h-full flex-col overflow-hidden rounded-md rounded-t-none border border-t-0 border-border/50 bg-muted/50 shadow-sm">
      <div
        className={`grid flex-none gap-3 border-b border-border/50 px-3 py-2 text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground ${ROW_COLUMNS}`}
      >
        <span>{t('components.taskPage.ngit.columnId', 'ID')}</span>
        <span>{t('components.taskPage.ngit.columnTitle', 'Title')}</span>
        <span>{t('components.taskPage.ngit.columnAuthor', 'Author')}</span>
        <span>{t('components.taskPage.ngit.columnType', 'Type / State')}</span>
        <span>{t('components.taskPage.ngit.columnUpdated', 'Updated')}</span>
        <span />
      </div>
      <div className="min-h-0 flex-initial overflow-y-auto scrollbar-sleek">
        {loading && items.length === 0 ? (
          <div className="divide-y divide-border/50">
            {Array.from({ length: 6 }, (_, index) => (
              <div key={index} className="px-3 py-2">
                <div className="h-4 w-3/5 animate-pulse rounded bg-muted/70" />
              </div>
            ))}
          </div>
        ) : items.length === 0 ? (
          <div className="px-4 py-12 text-center">
            <p className="text-base font-medium text-foreground">{emptyTitle}</p>
            <p className="mt-2 text-sm text-muted-foreground">{emptyDescription}</p>
          </div>
        ) : null}
        <div className="divide-y divide-border/50">
          {items.map((item) => {
            const attached = workspaceOf(item)
            const useLabel = !attached
              ? t('auto.components.TaskPage.7d08e8be0f', 'Start')
              : item.type === 'pr'
                ? t('auto.components.TaskPage.7753652524', 'Resume')
                : t('auto.components.TaskPage.606a85c774', 'Open')
            return (
              // A div button, because the row nests its own buttons.
              <div
                role="button"
                tabIndex={0}
                key={`${item.repoHostId ?? ''}:${item.id}`}
                onClick={() => onOpen(item)}
                onKeyDown={(event) => {
                  if (
                    event.target === event.currentTarget &&
                    (event.key === 'Enter' || event.key === ' ')
                  ) {
                    event.preventDefault()
                    onOpen(item)
                  }
                }}
                className={`grid w-full cursor-pointer items-center gap-3 px-3 py-2 text-left hover:bg-muted/50 ${ROW_COLUMNS}`}
              >
                <span className="font-mono text-xs text-muted-foreground">
                  {ngitShortId(item.eventId)}
                </span>
                <span className="flex min-w-0 items-center gap-2 text-sm">
                  <NgitStateIcon item={item} className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate">{item.title}</span>
                  {attached ? (
                    <span className="inline-flex min-w-0 shrink items-center gap-1 text-xs text-muted-foreground">
                      <FolderKanban className="size-3 shrink-0" />
                      <span className="truncate">{getWorktreeAttachmentLabel(attached)}</span>
                    </span>
                  ) : null}
                  {item.labels.map((label) => (
                    <span
                      key={label}
                      className="shrink-0 rounded-full border border-border/50 bg-muted/40 px-2 py-0.5 text-[10px] font-medium text-muted-foreground"
                    >
                      {label}
                    </span>
                  ))}
                </span>
                <span className="truncate text-xs text-muted-foreground">{item.author}</span>
                <span className="text-xs text-muted-foreground">
                  {ngitTypeLabel(item)} · {ngitStateLabel(item)}
                </span>
                <span className="text-xs text-muted-foreground">
                  {new Date(item.updatedAt).toLocaleDateString(intlLocale)}
                </span>
                <div className="flex items-center justify-end gap-1">
                  <Button
                    variant={attached ? 'default' : 'outline'}
                    size="xs"
                    aria-label={attached ? undefined : startWorkspace}
                    onClick={(event) => {
                      event.stopPropagation()
                      onUse(item)
                    }}
                  >
                    {useLabel}
                    <ArrowRight className="size-3" />
                  </Button>
                  {attached ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          aria-label={startNew}
                          onClick={(event) => {
                            event.stopPropagation()
                            onStartNew(item)
                          }}
                        >
                          <Plus className="size-3.5" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side="bottom" sideOffset={6}>
                        {startNew}
                      </TooltipContent>
                    </Tooltip>
                  ) : null}
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={openInBrowser}
                    onClick={(event) => {
                      event.stopPropagation()
                      openAppHttpLink(item.url, { event })
                    }}
                  >
                    <ExternalLink className="size-3.5" />
                  </Button>
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
