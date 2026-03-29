import type { ReactNode } from 'react'
import type { GlobalSettings } from '../../../../shared/types'
import { Button } from '../ui/button'
import { Label } from '../ui/label'
import { Separator } from '../ui/separator'
import { BellRing, Bot, Siren } from 'lucide-react'

type NotificationsPaneProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function NotificationsPane({
  settings,
  updateSettings
}: NotificationsPaneProps): React.JSX.Element {
  const notificationSettings = settings.notifications

  const updateNotificationSettings = (updates: Partial<GlobalSettings['notifications']>): void => {
    updateSettings({
      notifications: {
        ...notificationSettings,
        ...updates
      }
    })
  }

  return (
    <div className="space-y-8">
      <section className="space-y-4">
        <div className="space-y-1">
          <h2 className="text-sm font-semibold">Desktop Notifications</h2>
          <p className="text-xs text-muted-foreground">
            Send native system notifications from Orca on macOS, Linux, and Windows.
          </p>
        </div>

        <SettingToggle
          label="Enable Notifications"
          description="Master switch for all Orca desktop notifications."
          checked={notificationSettings.enabled}
          onToggle={() => updateNotificationSettings({ enabled: !notificationSettings.enabled })}
        />

        <div className="flex items-center gap-3">
          <Button
            variant="outline"
            size="sm"
            disabled={!notificationSettings.enabled}
            onClick={() => void window.api.notifications.dispatch({ source: 'test' })}
            className="gap-2"
          >
            <BellRing className="size-3.5" />
            Send Test Notification
          </Button>
          <p className="text-xs text-muted-foreground">
            Uses the same native delivery path as real Orca notifications.
          </p>
        </div>
      </section>

      <Separator />

      <section className="space-y-4">
        <div className="space-y-1">
          <h2 className="text-sm font-semibold">Triggers</h2>
          <p className="text-xs text-muted-foreground">
            Choose which background events should surface outside the app.
          </p>
        </div>

        <SettingToggle
          icon={<Bot className="size-4" />}
          label="Agent Task Complete"
          description="Notify when a coding agent transitions from working to idle."
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
          description="Notify when a background terminal emits a bell character."
          checked={notificationSettings.terminalBell}
          disabled={!notificationSettings.enabled}
          onToggle={() =>
            updateNotificationSettings({
              terminalBell: !notificationSettings.terminalBell
            })
          }
        />
      </section>

      <Separator />

      <section className="space-y-4">
        <div className="space-y-1">
          <h2 className="text-sm font-semibold">Filtering</h2>
          <p className="text-xs text-muted-foreground">
            Reduce noise when you are already looking at the relevant worktree.
          </p>
        </div>

        <SettingToggle
          label="Suppress While Focused"
          description="Do not notify when Orca is focused and the triggering worktree is already active."
          checked={notificationSettings.suppressWhenFocused}
          disabled={!notificationSettings.enabled}
          onToggle={() =>
            updateNotificationSettings({
              suppressWhenFocused: !notificationSettings.suppressWhenFocused
            })
          }
        />
      </section>
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
