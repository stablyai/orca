import { CircleAlert, CircleCheck, Download, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { useTranslate } from '@/i18n/use-translate'
import { AgentCliUpdateToastList, type AgentCliUpdateToastItem } from './AgentCliUpdateToastList'

export type AgentCliUpdateToastView = 'offer' | 'updating' | 'failed' | 'done'

/** The CLI updates toast: icon, count, Show list under it, and the view's actions. */
export function AgentCliUpdateToast({
  view,
  total,
  settled,
  failed,
  canUpdate,
  items,
  listOpen,
  onToggleList,
  onClose,
  onUpdate,
  onRetry,
  onKeyDown
}: {
  view: AgentCliUpdateToastView
  /** CLIs Update would start, or the run started. */
  total: number
  settled: number
  failed: number
  /** Whether Update has CLIs to start; an offer of hand-updated CLIs only has none. */
  canUpdate: boolean
  /** Called only while the list is open. */
  items: () => readonly AgentCliUpdateToastItem[]
  listOpen: boolean
  onToggleList: () => void
  onClose: () => void
  onUpdate: () => void
  onRetry: () => void
  onKeyDown?: (event: React.KeyboardEvent) => void
}): React.JSX.Element {
  const t = useTranslate()
  const title =
    view === 'offer'
      ? t('agentCliUpdate.statusCount', '{{count}} CLI updates', {
          count: total,
          defaultValue_one: '{{count}} CLI update'
        })
      : view === 'updating'
        ? t('agentCliUpdate.toastUpdating', 'Updating {{current}} of {{count}} CLIs', {
            current: Math.min(settled + 1, total),
            count: total,
            defaultValue_one: 'Updating {{current}} of {{count}} CLI'
          })
        : view === 'failed'
          ? t('agentCliUpdate.toastFailedCount', '{{count}} updates failed', {
              count: failed,
              defaultValue_one: '{{count}} update failed'
            })
          : t('agentCliUpdate.toastDone', '{{count}} CLIs updated', {
              count: total,
              defaultValue_one: '{{count}} CLI updated'
            })
  // Announced once per view, not per finished CLI.
  const announcement =
    view === 'updating' ? t('agentCliUpdate.statusUpdating', 'Updating CLIs') : title

  return (
    <Card
      size="notice"
      role="complementary"
      aria-label={t('agentCliUpdate.cardLabel', 'Agent CLI updates')}
      onKeyDown={onKeyDown}
      className="overflow-hidden"
    >
      <p role="status" className="sr-only">
        {announcement}
      </p>
      <div className="p-2">
        <div className="flex items-center gap-2 px-2 py-1">
          <span className="flex size-5 shrink-0 items-center justify-center" aria-hidden>
            {view === 'updating' ? (
              <Loader2 className="size-4 animate-spin text-muted-foreground motion-reduce:animate-none" />
            ) : view === 'done' ? (
              <CircleCheck className="size-4 text-status-success" />
            ) : view === 'failed' ? (
              <CircleAlert className="size-4 text-destructive" />
            ) : (
              <Download className="size-4 text-muted-foreground" />
            )}
          </span>
          <div className="flex min-w-0 flex-1 flex-col items-start">
            <p className="w-full truncate text-[13px] font-semibold" aria-hidden>
              {title}
            </p>
            <Button
              type="button"
              variant="ghost-muted"
              size="xs"
              className="-ml-2"
              aria-expanded={listOpen}
              onClick={onToggleList}
            >
              {listOpen
                ? t('agentCliUpdate.hideList', 'Hide list')
                : t('agentCliUpdate.showList', 'Show list')}
            </Button>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {view === 'updating' ? (
              // Updates keep running; the status bar still shows them, with Try again on a failure.
              <Button type="button" variant="ghost" size="sm" onClick={onClose}>
                {t('agentCliUpdate.toastClose', 'Close')}
              </Button>
            ) : view !== 'done' ? (
              <Button type="button" variant="ghost" size="sm" onClick={onClose}>
                {t('agentCliUpdate.cardLater', 'Later')}
              </Button>
            ) : null}
            {view === 'offer' && canUpdate ? (
              <Button type="button" size="sm" onClick={onUpdate}>
                {t('agentCliUpdate.toastUpdate', 'Update {{total}}', { total })}
              </Button>
            ) : view === 'failed' ? (
              <Button type="button" size="sm" onClick={onRetry}>
                {t('agentCliUpdate.toastRetry', 'Retry {{failed}}', { failed })}
              </Button>
            ) : null}
          </div>
        </div>
        <AgentCliUpdateToastList open={listOpen} items={items} />
      </div>
    </Card>
  )
}
