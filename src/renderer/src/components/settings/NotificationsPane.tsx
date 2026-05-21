import { type ReactNode, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import type { GlobalSettings } from '../../../../shared/types'
import { Button } from '../ui/button'
import { Label } from '../ui/label'
import { Separator } from '../ui/separator'
import { Slider } from '../ui/slider'
import { BellRing, Bot, FileAudio, Siren, Volume2, X } from 'lucide-react'
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
    title: 'Notification Volume',
    description: 'Playback volume for the custom notification sound.',
    keywords: ['notifications', 'sound', 'volume', 'loudness']
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

type SystemNotificationSettingsCopy = {
  failureTitle: string
  failureDescription: string
}

function getSystemNotificationSettingsCopy(
  platform: NodeJS.Platform
): SystemNotificationSettingsCopy | null {
  if (platform === 'darwin') {
    return {
      failureTitle: 'macOS did not show the notification',
      failureDescription: 'Enable Allow notifications for Orca in System Settings.'
    }
  }

  if (platform === 'win32') {
    return {
      failureTitle: 'Windows did not show the notification',
      failureDescription: 'Enable notifications for Orca in Windows Settings.'
    }
  }

  return null
}

export async function sendNotificationSettingsTestNotification(
  notificationSettings: GlobalSettings['notifications'],
  volumeDraft: number
): Promise<void> {
  const permissionStatus = await window.api.notifications.getPermissionStatus()
  if (!permissionStatus.supported) {
    toast.error('Notifications are not supported on this system')
    return
  }

  const result = await window.api.notifications.dispatch({
    source: 'test',
    requireDisplayConfirmation: true
  })
  if (result.delivered) {
    // Why: the Test button must always play through, even if the user clicks
    // it twice in quick succession — the in-flight dedupe is for incidental
    // bursts of real notifications, not for an explicit user action.
    const soundResult = notificationSettings.customSoundPath
      ? await window.api.notifications.playSound({
          force: true,
          volume: volumeDraft
        })
      : null
    if (notificationSettings.customSoundPath && soundResult && !soundResult.played) {
      toast.error('Custom notification sound could not be played')
      return
    }
    const settingsCopy = getSystemNotificationSettingsCopy(permissionStatus.platform)
    if (permissionStatus.platform === 'darwin' && settingsCopy) {
      // Why: Electron's native 'show' event can fire even when macOS silently
      // drops the banner because the per-app Allow notifications switch is off.
      toast.message('Test notification requested', {
        description: 'If no macOS banner appeared, enable Allow notifications for Orca.',
        action: {
          label: 'Open Settings',
          onClick: () => {
            void window.api.notifications.openSystemSettings()
          }
        }
      })
      return
    }
    toast.success('Test notification sent')
    return
  }

  if (result.reason === 'not-displayed') {
    const settingsCopy = getSystemNotificationSettingsCopy(permissionStatus.platform)
    if (settingsCopy) {
      toast.error(settingsCopy.failureTitle, {
        description: settingsCopy.failureDescription,
        action: {
          label: 'Open Settings',
          onClick: () => {
            void window.api.notifications.openSystemSettings()
          }
        }
      })
    } else {
      toast.error('System did not show the notification', {
        description: 'Check your desktop notification settings for Orca.'
      })
    }
    return
  }

  toast.error(
    result.reason === 'disabled'
      ? 'Notifications are disabled'
      : 'Test notification was not delivered'
  )
}

export function NotificationsPane({
  settings,
  updateSettings
}: NotificationsPaneProps): React.JSX.Element {
  const notificationSettings = settings.notifications
  const notificationSettingsRef = useRef(notificationSettings)
  const [isPickingSound, setIsPickingSound] = useState(false)

  const updateNotificationSettings = (updates: Partial<GlobalSettings['notifications']>): void => {
    updateSettings({
      notifications: {
        ...notificationSettingsRef.current,
        ...updates
      }
    })
  }

  // Why: keep dragging local and persist only on Radix's commit event. That
  // avoids IPC on every tick without a debounce timer that can race settings updates.
  const [volumeDraft, setVolumeDraft] = useState(notificationSettings.customSoundVolume)

  useEffect(() => {
    notificationSettingsRef.current = notificationSettings
    setVolumeDraft(notificationSettings.customSoundVolume)
  }, [notificationSettings])

  const handleVolumeCommit = (value: number): void => {
    if (notificationSettingsRef.current.customSoundVolume !== value) {
      updateNotificationSettings({ customSoundVolume: value })
    }
  }

  const handleSendTestNotification = async (): Promise<void> => {
    await sendNotificationSettingsTestNotification(notificationSettings, volumeDraft)
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
        {selectedSoundPath ? (
          <div className="flex items-center gap-3 pt-1">
            <Volume2 className="size-4 text-muted-foreground" />
            <Slider
              value={[volumeDraft]}
              min={0}
              max={100}
              step={5}
              disabled={!notificationSettings.enabled}
              onValueChange={([value]) => setVolumeDraft(value)}
              onValueCommit={([value]) => handleVolumeCommit(value)}
              className="flex-1"
              aria-label="Notification sound volume"
            />
            <span className="w-10 text-right font-mono text-xs tabular-nums text-muted-foreground">
              {volumeDraft}%
            </span>
          </div>
        ) : null}
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

      <div className="flex flex-wrap items-center gap-2 px-1 pt-3">
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
