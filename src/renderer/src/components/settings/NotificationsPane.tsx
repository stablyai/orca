import { type ReactNode, useState } from 'react'
import { toast } from 'sonner'
import type { GlobalSettings } from '../../../../shared/types'
import { Button } from '../ui/button'
import { Label } from '../ui/label'
import { Separator } from '../ui/separator'
import { BellRing, Bot, FileAudio, Siren, X } from 'lucide-react'
import type { SettingsSearchEntry } from './settings-search'
import { basename } from '@/lib/path'

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
    title: 'Custom Sound',
    description:
      'Choose one local audio file (MP3, WAV, OGG, M4A, AAC, or FLAC) for all delivered desktop notifications.',
    keywords: ['notifications', 'sound', 'audio', 'mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac']
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
  const [isPickingSound, setIsPickingSound] = useState(false)

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
    if (result.delivered) {
      // Why: the Test button must always play through, even if the user clicks
      // it twice in quick succession — the in-flight dedupe is for incidental
      // bursts of real notifications, not for an explicit user action.
      const soundResult = notificationSettings.customSoundPath
        ? await window.api.notifications.playSound({ force: true })
        : null
      if (notificationSettings.customSoundPath && soundResult && !soundResult.played) {
        toast.error('Custom notification sound could not be played')
        return
      }
      toast.success('Test notification sent')
    }
  }

  const handleChooseSound = async (): Promise<void> => {
    setIsPickingSound(true)
    try {
      const soundPath = await window.api.shell.pickAudio()
      if (soundPath) {
        updateNotificationSettings({ customSoundPath: soundPath })
      }
    } finally {
      setIsPickingSound(false)
    }
  }

  const selectedSoundPath = notificationSettings.customSoundPath

  return (
    <div className="space-y-1">
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

      <div className="space-y-2 px-1 py-2">
        <div className="space-y-0.5">
          <div className="flex items-center gap-2">
            <FileAudio className="size-4" />
            <Label>Custom Sound</Label>
          </div>
          <p className="text-xs text-muted-foreground">
            One local audio file for all delivered desktop notifications.
          </p>
          <p className="text-[11px] text-muted-foreground/80">
            Supported formats: MP3, WAV, OGG, M4A, AAC, FLAC.
          </p>
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <div
            className="min-h-8 min-w-0 flex-1 rounded-md border border-border/50 bg-muted/35 px-2.5 py-1.5"
            title={selectedSoundPath ?? undefined}
          >
            {selectedSoundPath ? (
              <div className="min-w-0">
                <div className="truncate text-xs font-medium">{basename(selectedSoundPath)}</div>
                <div className="truncate font-mono text-[11px] text-muted-foreground">
                  {selectedSoundPath}
                </div>
              </div>
            ) : (
              <div className="text-xs text-muted-foreground">System notification sound</div>
            )}
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!notificationSettings.enabled || isPickingSound}
            onClick={() => void handleChooseSound()}
            className="gap-2"
          >
            <FileAudio className="size-3.5" />
            {selectedSoundPath ? 'Change' : 'Choose'}
          </Button>
          {selectedSoundPath ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={!notificationSettings.enabled}
              onClick={() => updateNotificationSettings({ customSoundPath: null })}
              className="gap-2"
            >
              <X className="size-3.5" />
              Clear
            </Button>
          ) : null}
        </div>
      </div>

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
