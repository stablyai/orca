import type { TaskPageComposerActionsModel } from '../use-task-page-composer-actions'
import { getIntlLocale, translate } from '@/i18n/i18n'
import { Check, ExternalLink } from 'lucide-react'
import { toast } from 'sonner'
import { giteaApiFor } from '@/runtime/gitea-owner-api'
import { Button } from '@/components/ui/button'
import type { GiteaNotification } from '../../../../../shared/gitea-types'
import { giteaTaskRepoSelector } from '../use-task-page-gitea-loading'

const GRID_CLASS = 'grid-cols-[110px_minmax(0,3fr)_minmax(120px,1.2fr)_110px_70px]'

export function TaskPageGiteaNotificationList({
  model
}: {
  model: TaskPageComposerActionsModel
}): React.JSX.Element | null {
  const { primaryRepo, giteaNotifications, giteaNotificationsLoading, setGiteaNotifications } =
    model
  // Optimistic: the feed lists unread items only, so a read one leaves it; failure restores the row.
  const markRead = async (notification: GiteaNotification): Promise<void> => {
    if (!primaryRepo) {
      return
    }
    setGiteaNotifications((current) => current.filter((entry) => entry.id !== notification.id))
    const restore = (): void =>
      setGiteaNotifications((current) =>
        current.some((entry) => entry.id === notification.id)
          ? current
          : [...current, notification].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      )
    try {
      const result = await giteaApiFor(giteaTaskRepoSelector(primaryRepo)).markNotificationRead({
        ...giteaTaskRepoSelector(primaryRepo),
        notificationId: notification.id
      })
      if (!result.ok) {
        restore()
        toast.error(result.error)
      }
    } catch (error) {
      restore()
      toast.error(error instanceof Error ? error.message : String(error))
    }
  }
  return (
    <div className="flex min-h-0 max-h-full flex-col rounded-md border border-t-0 border-border/50 bg-muted/50 overflow-hidden rounded-t-none shadow-sm">
      <div
        className={`flex-none grid ${GRID_CLASS} gap-3 border-b border-border/50 px-3 py-2 text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground`}
      >
        <span>{translate('auto.components.TaskPage.giteaNotificationType', 'Type')}</span>
        <span>{translate('auto.components.TaskPage.16cba35bee', 'Title')}</span>
        <span>{translate('auto.components.TaskPage.00022ec0ba', 'Project')}</span>
        <span>{translate('auto.components.TaskPage.f362667d55', 'Updated')}</span>
        <span />
      </div>
      <div
        className="min-h-0 flex-initial overflow-y-auto scrollbar-sleek"
        style={{ scrollbarGutter: 'stable' }}
      >
        {giteaNotificationsLoading && giteaNotifications.length === 0 ? (
          <div className="divide-y divide-border/50">
            {Array.from({ length: 12 }).map((_, i) => (
              <div key={i} className={`grid w-full gap-3 px-3 py-2 ${GRID_CLASS}`}>
                <div className="h-4 w-20 animate-pulse rounded bg-muted/70" />
                <div>
                  <div className="h-4 w-3/5 animate-pulse rounded bg-muted/70" />
                </div>
                <div className="h-3 w-24 animate-pulse rounded bg-muted/60" />
                <div className="h-3 w-20 animate-pulse rounded bg-muted/60" />
                <div />
              </div>
            ))}
          </div>
        ) : null}
        {!giteaNotificationsLoading && giteaNotifications.length === 0 ? (
          <div className="px-4 py-12 text-center text-sm text-muted-foreground">
            {primaryRepo
              ? translate(
                  'auto.components.TaskPage.giteaNoNotifications',
                  'No notifications. You’re all caught up!'
                )
              : translate(
                  'auto.components.TaskPage.giteaSelectProject',
                  'Select a project so we can authenticate to Gitea.'
                )}
          </div>
        ) : null}
        <div className="divide-y divide-border/50">
          {giteaNotifications.map((notification) => (
            <div
              role="button"
              tabIndex={0}
              key={notification.id}
              onClick={() => void window.api.shell.openUrl(notification.subjectUrl)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  void window.api.shell.openUrl(notification.subjectUrl)
                }
              }}
              className={`grid w-full cursor-pointer gap-3 px-3 py-2 text-left ${GRID_CLASS} hover:bg-muted/50`}
              title={
                notification.subjectNumber !== null
                  ? `#${notification.subjectNumber}`
                  : notification.subjectType
              }
            >
              <span className="text-xs text-muted-foreground">{notification.subjectType}</span>
              <span
                className={`min-w-0 truncate text-sm ${notification.unread ? 'font-medium' : ''}`}
              >
                {notification.subjectTitle}
              </span>
              <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">
                {notification.repositoryPath}
              </span>
              <span className="text-xs text-muted-foreground">
                {notification.updatedAt
                  ? new Date(notification.updatedAt).toLocaleDateString(getIntlLocale())
                  : ''}
              </span>
              <span className="flex items-center justify-end gap-1">
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-6"
                  aria-label={translate(
                    'auto.components.TaskPage.giteaMarkNotificationRead',
                    'Mark as read'
                  )}
                  onClick={(e) => {
                    e.stopPropagation()
                    void markRead(notification)
                  }}
                  onKeyDown={(e) => e.stopPropagation()}
                >
                  <Check className="size-3.5" />
                </Button>
                <ExternalLink className="size-3.5 text-muted-foreground" />
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
