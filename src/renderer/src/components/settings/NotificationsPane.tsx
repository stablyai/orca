/* eslint-disable max-lines -- Why: notification settings keeps delivery toggles, system test feedback, and sound selection on one settings merge path. */
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import type { GlobalSettings } from '../../../../shared/types'
import { Button } from '../ui/button'
import { Label } from '../ui/label'
import { Separator } from '../ui/separator'
import { Slider } from '../ui/slider'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue
} from '../ui/select'
import { BellRing, Bot, FileAudio, Siren, Upload, Volume2 } from 'lucide-react'
import { getNotificationSoundOptions } from '@/components/notification-sound-options'
import { useMountedRef } from '@/hooks/useMountedRef'
import { useAppStore } from '@/store'
export { NOTIFICATIONS_PANE_SEARCH_ENTRIES } from './notifications-search'

type NotificationsPaneProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void | Promise<void>
}

const CHOOSE_CUSTOM_SOUND_VALUE = 'choose-custom-file'

type NotificationSoundSelectValue =
  | GlobalSettings['notifications']['customSoundId']
  | typeof CHOOSE_CUSTOM_SOUND_VALUE

function isNotificationSoundId(
  value: NotificationSoundSelectValue
): value is GlobalSettings['notifications']['customSoundId'] {
  return value !== CHOOSE_CUSTOM_SOUND_VALUE
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
    const soundResult =
      notificationSettings.customSoundId !== 'system'
        ? await window.api.notifications.playSound({
            force: true,
            volume: volumeDraft
          })
        : null
    if (notificationSettings.customSoundId !== 'system' && soundResult && !soundResult.played) {
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
  const mountedRef = useMountedRef()
  const [isPickingSound, setIsPickingSound] = useState(false)

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

  // Why: keep dragging local and persist only on Radix's commit event. That
  // avoids IPC on every tick without a debounce timer that can race settings updates.
  const [volumeDraft, setVolumeDraft] = useState(notificationSettings.customSoundVolume)

  useEffect(() => {
    notificationSettingsRef.current = notificationSettings
    setVolumeDraft(notificationSettings.customSoundVolume)
  }, [notificationSettings])

  const handleVolumeCommit = (value: number): void => {
    if (notificationSettingsRef.current.customSoundVolume !== value) {
      void updateNotificationSettings({ customSoundVolume: value })
    }
  }

  const handleSendTestNotification = async (): Promise<void> => {
    useAppStore.getState().recordFeatureInteraction('notifications')
    await sendNotificationSettingsTestNotification(notificationSettings, volumeDraft)
  }

  const previewSound = async (
    customSoundId: GlobalSettings['notifications']['customSoundId']
  ): Promise<void> => {
    if (customSoundId === 'system') {
      return
    }
    const result = await window.api.notifications.playSound({
      force: true,
      volume: volumeDraft
    })
    if (!result.played) {
      toast.error('Notification sound could not be played')
    }
  }

  const handleChooseCustomSound = async (): Promise<void> => {
    setIsPickingSound(true)
    try {
      const soundPath = await window.api.shell.pickAudio()
      if (soundPath) {
        await updateNotificationSettings({ customSoundId: 'custom', customSoundPath: soundPath })
        await previewSound('custom')
      }
    } finally {
      if (mountedRef.current) {
        setIsPickingSound(false)
      }
    }
  }

  const handleSoundSelect = async (value: NotificationSoundSelectValue): Promise<void> => {
    if (!isNotificationSoundId(value)) {
      await handleChooseCustomSound()
      return
    }
    await updateNotificationSettings({ customSoundId: value })
    await previewSound(value)
  }

  const selectedSoundId = notificationSettings.customSoundId
  const soundOptions = getNotificationSoundOptions(notificationSettings.customSoundPath)

  return (
    <div className="space-y-1">
      <SettingToggle
        label="Enable Notifications"
        description="Native system notifications for background events."
        checked={notificationSettings.enabled}
        onToggle={() => {
          if (!notificationSettings.enabled) {
            useAppStore.getState().recordFeatureInteraction('notifications')
          }
          void updateNotificationSettings({ enabled: !notificationSettings.enabled })
        }}
      />

      <Separator />

      <SettingToggle
        icon={<Bot className="size-4" />}
        label="Agent Task Complete"
        description="A coding agent finishes and becomes idle."
        checked={notificationSettings.agentTaskComplete}
        disabled={!notificationSettings.enabled}
        onToggle={() =>
          void updateNotificationSettings({
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
          void updateNotificationSettings({
            terminalBell: !notificationSettings.terminalBell
          })
        }
      />

      <Separator />

      <div className="space-y-2 py-2">
        <div className="space-y-0.5">
          <div className="flex items-center gap-2">
            <FileAudio className="size-4" />
            <Label>Notification Sound</Label>
          </div>
          <p className="text-xs text-muted-foreground">
            Choose the alert Orca plays when a desktop notification is delivered.
          </p>
        </div>
        <Select
          value={selectedSoundId}
          disabled={!notificationSettings.enabled || isPickingSound}
          onValueChange={(value) => void handleSoundSelect(value as NotificationSoundSelectValue)}
        >
          <SelectTrigger className="w-full max-w-[360px]" size="sm">
            <SelectValue placeholder="Choose notification sound" />
          </SelectTrigger>
          <SelectContent align="start" className="w-[--radix-select-trigger-width]">
            {soundOptions.map((option) => {
              const OptionIcon = option.icon
              return (
                <SelectItem key={option.id} value={option.id}>
                  <OptionIcon className="size-4" />
                  <span className="truncate">{option.title}</span>
                </SelectItem>
              )
            })}
            <SelectSeparator />
            <SelectItem value={CHOOSE_CUSTOM_SOUND_VALUE}>
              <Upload className="size-4" />
              <span>
                {notificationSettings.customSoundPath ? 'Change Custom File' : 'Choose Custom File'}
              </span>
            </SelectItem>
          </SelectContent>
        </Select>
        {notificationSettings.customSoundPath ? (
          <p
            className="truncate font-mono text-[11px] text-muted-foreground"
            title={notificationSettings.customSoundPath}
          >
            Custom: {notificationSettings.customSoundPath}
          </p>
        ) : null}
        {selectedSoundId !== 'system' ? (
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
          Send Test Notification
        </Button>
      </div>
    </div>
  )
}

export type SettingToggleProps = {
  label: string
  description: string
  checked: boolean
  onToggle: () => void
  disabled?: boolean
  icon?: ReactNode
}

export function SettingToggle({
  label,
  description,
  checked,
  onToggle,
  disabled = false,
  icon
}: SettingToggleProps): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-4 py-2">
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
