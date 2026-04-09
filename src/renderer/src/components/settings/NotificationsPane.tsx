import { type ReactNode, useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import type { GlobalSettings } from '../../../../shared/types'
import { Button } from '../ui/button'
import { Label } from '../ui/label'
import { Separator } from '../ui/separator'
import { BellRing, Bot, Siren, TriangleAlert } from 'lucide-react'
import type { SettingsSearchEntry } from './settings-search'

export const NOTIFICATIONS_PANE_SEARCH_ENTRIES: SettingsSearchEntry[] = [
  {
    title: 'Enable Notifications',
    description: 'Master switch for Orca desktop notifications.',
    keywords: ['notifications', 'desktop', 'system', 'native']
  },
  {
    title: 'Agent Task Complete',
    description: 'Notify when a coding agent transitions from working to idle.',
    keywords: ['notifications', 'agent', 'complete', 'idle', 'task']
  },
  {
    title: 'Terminal Bell',
    description: 'Notify when a background terminal emits a bell character.',
    keywords: ['notifications', 'terminal', 'bell', 'attention']
  },
  {
    title: 'Suppress While Focused',
    description: 'Avoid notifying when Orca is focused on the active worktree.',
    keywords: ['notifications', 'focused', 'suppress', 'filtering']
  },
  {
    title: 'Send Test Notification',
    description: 'Trigger a sample desktop notification using the native delivery path.',
    keywords: ['notifications', 'test']
  }
]

type NotificationsPaneProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function NotificationsPane({
  settings,
  updateSettings
}: NotificationsPaneProps): React.JSX.Element {
  const notificationSettings = settings.notifications
  const [permissionBlocked, setPermissionBlocked] = useState(false)

  const recheckPermission = useCallback(() => {
    void window.api.notifications.getPermissionStatus().then((status) => {
      // Why: only flag 'denied', not 'not-determined'. 'not-determined' means
      // macOS hasn't prompted the user yet — the startup registration or the
      // next notification dispatch will trigger that dialog. Showing "blocked"
      // for a permission that was never asked would be misleading.
      setPermissionBlocked(status === 'denied')
    })
  }, [])

  useEffect(() => {
    if (!notificationSettings.enabled) {
      setPermissionBlocked(false)
      return
    }
    recheckPermission()
  }, [notificationSettings.enabled, recheckPermission])

  const updateNotificationSettings = (updates: Partial<GlobalSettings['notifications']>): void => {
    updateSettings({
      notifications: {
        ...notificationSettings,
        ...updates
      }
    })
  }

  const handleSendTestNotification = async (): Promise<void> => {
    const result = await window.api.notifications.dispatch({ source: 'test' })
    if (!result.delivered && result.reason === 'system-denied') {
      // Why: don't auto-open System Settings — the yellow banner above already
      // provides the "Open Notification Settings" button. Just tell the user
      // what happened so the silent failure isn't confusing.
      toast.error('Notification blocked by macOS', {
        description: 'Allow notifications for Orca in System Settings → Notifications.'
      })
    }
    // Why: the macOS permission dialog may have appeared (for 'not-determined'
    // status), so re-check to update the banner accordingly.
    recheckPermission()
  }

  return (
    <div className="space-y-1">
      {notificationSettings.enabled && permissionBlocked && (
        <div className="mx-1 mb-2 flex items-start gap-2.5 rounded-md border border-yellow-500/30 bg-yellow-500/10 px-3 py-2.5">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-yellow-500" />
          <div className="space-y-1.5">
            <p className="text-xs text-foreground">
              Notifications are blocked by your system settings.
            </p>
            <Button
              variant="outline"
              size="sm"
              className="h-6 text-xs"
              onClick={() => void window.api.notifications.openSystemSettings()}
            >
              Open Notification Settings
            </Button>
          </div>
        </div>
      )}

      <SettingToggle
        label="Enable Notifications"
        description="Native system notifications for background events."
        checked={notificationSettings.enabled}
        onToggle={() => updateNotificationSettings({ enabled: !notificationSettings.enabled })}
      />

      <Separator />

      <SettingToggle
        icon={<Bot className="size-4" />}
        label="Agent Task Complete"
        description="A coding agent finishes and becomes idle."
        checked={notificationSettings.agentTaskComplete}
        disabled={!notificationSettings.enabled}
        onToggle={() =>
          updateNotificationSettings({
            agentTaskComplete: !notificationSettings.agentTaskComplete
          })
        }
      />

      <SettingToggle
        icon={<Siren className="size-4" />}
        label="Terminal Bell"
        description="A background terminal emits a bell character."
        checked={notificationSettings.terminalBell}
        disabled={!notificationSettings.enabled}
        onToggle={() =>
          updateNotificationSettings({
            terminalBell: !notificationSettings.terminalBell
          })
        }
      />

      <Separator />

      <SettingToggle
        label="Suppress While Focused"
        description="Skip notifications when the triggering worktree is already visible."
        checked={notificationSettings.suppressWhenFocused}
        disabled={!notificationSettings.enabled}
        onToggle={() =>
          updateNotificationSettings({
            suppressWhenFocused: !notificationSettings.suppressWhenFocused
          })
        }
      />

      <div className="px-1 pt-3">
        <Button
          variant="outline"
          size="sm"
          disabled={!notificationSettings.enabled}
          onClick={() => void handleSendTestNotification()}
          className="gap-2"
        >
          <BellRing className="size-3.5" />
          Send Test Notification
        </Button>
      </div>
    </div>
  )
}

type SettingToggleProps = {
  label: string
  description: string
  checked: boolean
  onToggle: () => void
  disabled?: boolean
  icon?: ReactNode
}

function SettingToggle({
  label,
  description,
  checked,
  onToggle,
  disabled = false,
  icon
}: SettingToggleProps): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-4 px-1 py-2">
      <div className="space-y-0.5">
        <div className="flex items-center gap-2">
          {icon}
          <Label>{label}</Label>
        </div>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <button
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={onToggle}
        className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-transparent transition-colors ${
          checked ? 'bg-foreground' : 'bg-muted-foreground/30'
        } ${disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}`}
      >
        <span
          className={`pointer-events-none block size-3.5 rounded-full bg-background shadow-sm transition-transform ${
            checked ? 'translate-x-4' : 'translate-x-0.5'
          }`}
        />
      </button>
    </div>
  )
}
