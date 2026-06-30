import { useEffect, useRef, useState } from 'react'
import type {
  GlobalSettings,
  NotificationInboxEntry,
  NotificationInboxResult
} from '../../../../shared/types'
import { Button } from '../ui/button'
import { Separator } from '../ui/separator'
import { BellRing, Bot, Inbox, MailCheck, Siren, Trash2 } from 'lucide-react'
import { useAppStore } from '@/store'
import { NotificationSettingToggle } from './NotificationSettingToggle'
import { NotificationSoundSection } from './NotificationSoundSection'
import { UnreadBadgeSection } from './UnreadBadgeSection'
import {
  createNotificationVolumeDraftState,
  resolveNotificationVolumeDraftState,
  sendNotificationSettingsTestNotification
} from './notification-settings-copy'
import { translate } from '@/i18n/i18n'
export { getNotificationsPaneSearchEntries } from './notifications-search'
export {
  createNotificationVolumeDraftState,
  resolveNotificationVolumeDraftState,
  sendNotificationSettingsTestNotification
} from './notification-settings-copy'

type NotificationsPaneProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void | Promise<void>
}

function getNotificationSourceLabel(source: NotificationInboxEntry['source']): string {
  switch (source) {
    case 'agent-task-complete':
      return translate('auto.components.settings.NotificationsPane.1cbe92dd41', 'Agent task')
    case 'terminal-bell':
      return translate('auto.components.settings.NotificationsPane.830de12dfc', 'Terminal bell')
  }
}

function getNotificationEntryContext(entry: NotificationInboxEntry): string {
  const sourceLabel = getNotificationSourceLabel(entry.source)
  if (entry.repoLabel && entry.worktreeLabel) {
    return `${sourceLabel} - ${entry.repoLabel} / ${entry.worktreeLabel}`
  }
  if (entry.worktreeLabel) {
    return `${sourceLabel} - ${entry.worktreeLabel}`
  }
  if (entry.repoLabel) {
    return `${sourceLabel} - ${entry.repoLabel}`
  }
  return sourceLabel
}

function formatNotificationInboxTime(createdAt: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  }).format(new Date(createdAt))
}

export function NotificationsPane({
  settings,
  updateSettings
}: NotificationsPaneProps): React.JSX.Element {
  const notificationSettings = settings.notifications
  const notificationSettingsRef = useRef(notificationSettings)
  const [inbox, setInbox] = useState<NotificationInboxResult | null>(null)
  const [inboxLoading, setInboxLoading] = useState(false)
  const [inboxMutating, setInboxMutating] = useState(false)
  const [inboxError, setInboxError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    async function loadInbox(): Promise<void> {
      setInboxLoading(true)
      setInboxError(null)
      try {
        const result = await window.api.notifications.getInbox()
        if (!cancelled) {
          setInbox(result)
        }
      } catch {
        if (!cancelled) {
          setInboxError(
            translate(
              'auto.components.settings.NotificationsPane.a331f7a7a8',
              'Could not load recent notifications.'
            )
          )
        }
      } finally {
        if (!cancelled) {
          setInboxLoading(false)
        }
      }
    }
    void loadInbox()
    return () => {
      cancelled = true
    }
  }, [])

  const handleMarkInboxRead = async (): Promise<void> => {
    setInboxMutating(true)
    setInboxError(null)
    try {
      setInbox(await window.api.notifications.markInboxRead())
    } catch {
      setInboxError(
        translate(
          'auto.components.settings.NotificationsPane.679b197b62',
          'Could not mark notifications as read.'
        )
      )
    } finally {
      setInboxMutating(false)
    }
  }

  const handleClearInbox = async (): Promise<void> => {
    setInboxMutating(true)
    setInboxError(null)
    try {
      setInbox(await window.api.notifications.clearInbox())
    } catch {
      setInboxError(
        translate(
          'auto.components.settings.NotificationsPane.1a2a47495a',
          'Could not clear recent notifications.'
        )
      )
    } finally {
      setInboxMutating(false)
    }
  }

  const updateNotificationSettings = async (
    updates: Partial<GlobalSettings['notifications']>
  ): Promise<void> => {
    const nextNotifications = {
      ...notificationSettingsRef.current,
      ...updates
    }
    notificationSettingsRef.current = nextNotifications
    await updateSettings({
      notifications: {
        ...nextNotifications
      }
    })
  }

  useEffect(() => {
    notificationSettingsRef.current = notificationSettings
  }, [notificationSettings])

  const [volumeDraftState, setVolumeDraftState] = useState(() =>
    createNotificationVolumeDraftState(notificationSettings.customSoundVolume)
  )
  const resolvedVolumeDraftState = resolveNotificationVolumeDraftState(
    volumeDraftState,
    notificationSettings.customSoundVolume
  )
  if (resolvedVolumeDraftState !== volumeDraftState) {
    setVolumeDraftState(resolvedVolumeDraftState)
  }
  const volumeDraft = resolvedVolumeDraftState.draft
  const setVolumeDraft = (value: number): void => {
    setVolumeDraftState((current) => ({
      ...resolveNotificationVolumeDraftState(current, notificationSettings.customSoundVolume),
      draft: value
    }))
  }

  const handleVolumeCommit = (value: number): void => {
    if (notificationSettingsRef.current.customSoundVolume !== value) {
      void updateNotificationSettings({ customSoundVolume: value })
    }
  }

  const handleSendTestNotification = async (): Promise<void> => {
    useAppStore.getState().recordFeatureInteraction('notifications')
    await sendNotificationSettingsTestNotification(notificationSettings, volumeDraft)
  }

  return (
    <div className="space-y-1">
      <NotificationSettingToggle
        label={translate(
          'auto.components.settings.NotificationsPane.841c8c549f',
          'Enable Notifications'
        )}
        description={translate(
          'auto.components.settings.NotificationsPane.deff6d30da',
          'Native system notifications for background events.'
        )}
        checked={notificationSettings.enabled}
        onToggle={() => {
          if (!notificationSettings.enabled) {
            useAppStore.getState().recordFeatureInteraction('notifications')
          }
          void updateNotificationSettings({ enabled: !notificationSettings.enabled })
        }}
      />

      <Separator />

      <NotificationSettingToggle
        icon={<Bot className="size-4" />}
        label={translate(
          'auto.components.settings.NotificationsPane.ca76d06fd2',
          'Agent Task Complete'
        )}
        description={translate(
          'auto.components.settings.NotificationsPane.55f901a59b',
          'A coding agent finishes and becomes idle.'
        )}
        checked={notificationSettings.agentTaskComplete}
        disabled={!notificationSettings.enabled}
        onToggle={() =>
          void updateNotificationSettings({
            agentTaskComplete: !notificationSettings.agentTaskComplete
          })
        }
      />

      <NotificationSettingToggle
        icon={<Siren className="size-4" />}
        label={translate('auto.components.settings.NotificationsPane.591fe605b9', 'Terminal Bell')}
        description={translate(
          'auto.components.settings.NotificationsPane.b6fc369244',
          'A background terminal emits a bell character.'
        )}
        checked={notificationSettings.terminalBell}
        disabled={!notificationSettings.enabled}
        onToggle={() =>
          void updateNotificationSettings({
            terminalBell: !notificationSettings.terminalBell
          })
        }
      />

      <Separator />

      <NotificationSoundSection
        notificationSettings={notificationSettings}
        notificationsEnabled={notificationSettings.enabled}
        volumeDraft={volumeDraft}
        onVolumeDraftChange={setVolumeDraft}
        onVolumeCommit={handleVolumeCommit}
        onUpdateNotificationSettings={updateNotificationSettings}
      />

      <Separator />

      <NotificationSettingToggle
        label={translate(
          'auto.components.settings.NotificationsPane.00cd406dbb',
          'Suppress While Focused'
        )}
        description={translate(
          'auto.components.settings.NotificationsPane.2772d2f257',
          'Skip notifications when the triggering worktree is already visible.'
        )}
        checked={notificationSettings.suppressWhenFocused}
        disabled={!notificationSettings.enabled}
        onToggle={() =>
          void updateNotificationSettings({
            suppressWhenFocused: !notificationSettings.suppressWhenFocused
          })
        }
      />

      <div className="flex flex-wrap items-center gap-2 pt-3">
        <Button
          variant="outline"
          size="sm"
          disabled={!notificationSettings.enabled}
          onClick={() => void handleSendTestNotification()}
          className="gap-2"
        >
          <BellRing className="size-3.5" />
          {translate(
            'auto.components.settings.NotificationsPane.906b4afebf',
            'Send Test Notification'
          )}
        </Button>
      </div>

      <Separator />

      <UnreadBadgeSection />

      <Separator />

      <section className="space-y-3 pt-3" aria-labelledby="notification-inbox-heading">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <Inbox className="size-4 text-muted-foreground" />
            <div className="min-w-0">
              <h3 id="notification-inbox-heading" className="text-sm font-medium">
                {translate(
                  'auto.components.settings.NotificationsPane.30e6463632',
                  'Notification Inbox'
                )}
              </h3>
              <p className="text-xs text-muted-foreground">
                {inbox && inbox.unreadCount > 0
                  ? translate(
                      'auto.components.settings.NotificationsPane.1f01232dad',
                      '{{count}} unread',
                      { count: inbox.unreadCount }
                    )
                  : translate(
                      'auto.components.settings.NotificationsPane.4b47bbd2bb',
                      'No unread notifications'
                    )}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="xs"
              className="gap-1.5"
              disabled={!inbox || inbox.unreadCount === 0 || inboxMutating}
              onClick={() => void handleMarkInboxRead()}
            >
              <MailCheck className="size-3.5" />
              {translate('auto.components.settings.NotificationsPane.b9375a63b5', 'Mark Read')}
            </Button>
            <Button
              variant="outline"
              size="xs"
              className="gap-1.5"
              disabled={!inbox || inbox.entries.length === 0 || inboxMutating}
              onClick={() => void handleClearInbox()}
            >
              <Trash2 className="size-3.5" />
              {translate('auto.components.settings.NotificationsPane.96b751e90c', 'Clear')}
            </Button>
          </div>
        </div>

        {inboxError ? <p className="text-xs text-destructive">{inboxError}</p> : null}

        <div className="space-y-2">
          {inboxLoading && !inbox ? (
            <div className="rounded-md border border-border px-3 py-3 text-xs text-muted-foreground">
              {translate(
                'auto.components.settings.NotificationsPane.b6401b8f5f',
                'Loading recent notifications...'
              )}
            </div>
          ) : inbox && inbox.entries.length > 0 ? (
            inbox.entries.map((entry) => (
              <article
                key={entry.id}
                className="rounded-md border border-border bg-card px-3 py-2 text-card-foreground"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 space-y-1">
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <h4 className="truncate text-sm font-medium">{entry.title}</h4>
                      {entry.unread ? (
                        <span className="rounded-full bg-secondary px-2 py-0.5 text-[11px] font-medium text-secondary-foreground">
                          {translate(
                            'auto.components.settings.NotificationsPane.bf95906231',
                            'Unread'
                          )}
                        </span>
                      ) : null}
                    </div>
                    {entry.body ? (
                      <p className="line-clamp-2 text-xs text-muted-foreground">{entry.body}</p>
                    ) : null}
                    <p className="text-[11px] text-muted-foreground">
                      {getNotificationEntryContext(entry)} -{' '}
                      {formatNotificationInboxTime(entry.createdAt)}
                    </p>
                  </div>
                </div>
              </article>
            ))
          ) : (
            <div className="rounded-md border border-dashed border-border px-3 py-4 text-center text-xs text-muted-foreground">
              {translate(
                'auto.components.settings.NotificationsPane.170f7a1a6a',
                'No recent notifications'
              )}
            </div>
          )}
        </div>
      </section>
    </div>
  )
}
