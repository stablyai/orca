/* eslint-disable max-lines -- Why: this onboarding step owns the full notification setup surface, including macOS guidance, sound choices, upload, and volume controls. */
import { useEffect, useRef, useState } from 'react'
import type { LucideIcon } from 'lucide-react'
import {
  Activity,
  AudioWaveform,
  Bell,
  BellRing,
  Check,
  ChevronDown,
  CircleDot,
  FileAudio,
  Keyboard,
  MousePointer2,
  Radio,
  Radar,
  Settings,
  Upload,
  Volume1,
  Volume2,
  X,
  Zap
} from 'lucide-react'
import { toast } from 'sonner'
import type { GlobalSettings, NotificationPermissionStatusResult } from '../../../../shared/types'
import { cn } from '@/lib/utils'
import { basename } from '@/lib/path'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Slider } from '@/components/ui/slider'
import { sendNotificationSettingsTestNotification } from '@/components/settings/NotificationsPane'
import logo from '../../../../../resources/logo.svg'

export type NotificationDraft = {
  agentTaskComplete: boolean
  terminalBell: boolean
  notifyWhenFocused: boolean
}

type NotificationStepProps = {
  settings: GlobalSettings | null
  updateSettings: (updates: Partial<GlobalSettings>) => Promise<void> | void
}

type NotificationSoundOption = {
  id: GlobalSettings['notifications']['customSoundId']
  title: string
  icon: LucideIcon
}

const SOUND_OPTIONS: readonly NotificationSoundOption[] = [
  {
    id: 'system',
    title: 'System Default',
    icon: Bell
  },
  {
    id: 'two-tone',
    title: 'Two Tone',
    icon: AudioWaveform
  },
  {
    id: 'bong',
    title: 'Bong',
    icon: CircleDot
  },
  {
    id: 'thump',
    title: 'Thump',
    icon: Volume1
  },
  {
    id: 'blip',
    title: 'Blip',
    icon: Zap
  },
  {
    id: 'sonar',
    title: 'Sonar',
    icon: Radar
  },
  {
    id: 'blop',
    title: 'Blop',
    icon: Activity
  },
  {
    id: 'ding',
    title: 'Ding',
    icon: Radio
  },
  {
    id: 'clack',
    title: 'Clack',
    icon: Keyboard
  },
  {
    id: 'beep',
    title: 'Beep',
    icon: MousePointer2
  }
]

export function NotificationStep({
  settings,
  updateSettings
}: NotificationStepProps): React.JSX.Element {
  const notificationSettings = settings?.notifications
  const notificationSettingsRef = useRef(notificationSettings)
  const [permissionStatus, setPermissionStatus] =
    useState<NotificationPermissionStatusResult | null>(null)
  const [volumeDraft, setVolumeDraft] = useState(notificationSettings?.customSoundVolume ?? 100)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [isPickingSound, setIsPickingSound] = useState(false)
  const [showMacSettingsPreview, setShowMacSettingsPreview] = useState(false)

  useEffect(() => {
    notificationSettingsRef.current = notificationSettings
    setVolumeDraft(notificationSettings?.customSoundVolume ?? 100)
  }, [notificationSettings])

  useEffect(() => {
    let cancelled = false
    void window.api.notifications.getPermissionStatus().then((status) => {
      if (!cancelled) {
        setPermissionStatus(status)
      }
    })
    return () => {
      cancelled = true
    }
  }, [])

  const updateNotificationSettings = async (
    updates: Partial<GlobalSettings['notifications']>
  ): Promise<void> => {
    const current = notificationSettingsRef.current
    if (!current) {
      return
    }
    const nextNotifications = {
      ...current,
      ...updates
    }
    notificationSettingsRef.current = nextNotifications
    await updateSettings({
      notifications: nextNotifications
    })
  }

  const handleMacPermission = async (): Promise<void> => {
    setShowMacSettingsPreview(true)
    const status = await window.api.notifications.requestPermission()
    setPermissionStatus(status)
    await window.api.notifications.openSystemSettings()
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

  const handleChooseBuiltInSound = async (
    customSoundId: GlobalSettings['notifications']['customSoundId']
  ): Promise<void> => {
    await updateNotificationSettings({ customSoundId })
    await previewSound(customSoundId)
  }

  const handleChooseCustomSound = async (): Promise<void> => {
    setIsPickingSound(true)
    try {
      const soundPath = await window.api.shell.pickAudio()
      if (soundPath) {
        await updateNotificationSettings({ customSoundId: 'custom', customSoundPath: soundPath })
        await previewSound('custom')
        setAdvancedOpen(true)
      }
    } finally {
      setIsPickingSound(false)
    }
  }

  const handleVolumeCommit = (value: number): void => {
    if (notificationSettingsRef.current?.customSoundVolume !== value) {
      void updateNotificationSettings({ customSoundVolume: value })
    }
  }

  const handleSendTestNotification = async (): Promise<void> => {
    if (!notificationSettings) {
      toast.error('Notification settings are still loading')
      return
    }
    await sendNotificationSettingsTestNotification(notificationSettings, volumeDraft)
  }

  if (!notificationSettings) {
    return (
      <div className="rounded-xl border border-border bg-muted/20 px-5 py-4 text-sm text-muted-foreground">
        Loading notification settings…
      </div>
    )
  }

  const customPath = notificationSettings.customSoundPath
  const selectedSoundId = notificationSettings.customSoundId
  const soundOptions = customPath
    ? [
        ...SOUND_OPTIONS,
        {
          id: 'custom' as const,
          title: basename(customPath),
          icon: FileAudio
        }
      ]
    : SOUND_OPTIONS
  const canAdjustVolume = selectedSoundId !== 'system'
  const isMac = permissionStatus?.platform === 'darwin'

  return (
    <div className="space-y-5">
      {isMac ? (
        <section className="rounded-xl border border-border bg-card px-5 py-4">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0 space-y-1">
              <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                <Settings className="size-4" />
                Allow Orca in macOS
              </div>
              <p className="max-w-[58ch] text-[13px] leading-relaxed text-muted-foreground">
                macOS controls notifications per app. Open System Settings and make sure Orca is
                allowed to show alerts and play sounds.
              </p>
            </div>
            <Button
              type="button"
              size="sm"
              className="gap-2"
              onClick={() => void handleMacPermission()}
            >
              <Settings className="size-3.5" />
              Open Mac Settings
            </Button>
          </div>
          {showMacSettingsPreview ? (
            <div className="mt-4 rounded-xl border border-border bg-[#1f1d24] p-3 text-white shadow-sm">
              <div className="flex items-center justify-between">
                <div className="flex min-w-0 items-center gap-3">
                  <div className="flex size-8 items-center justify-center rounded-lg bg-white/10 ring-1 ring-white/15">
                    <img src={logo} alt="" aria-hidden className="size-5 rounded-md" />
                  </div>
                  <div className="min-w-0">
                    <div className="text-sm font-medium leading-tight">Allow notifications</div>
                    <div className="text-xs leading-tight text-white/55">Orca</div>
                  </div>
                </div>
                <div
                  aria-hidden
                  className="relative h-6 w-11 rounded-full bg-[#0a84ff] shadow-inner"
                >
                  <div className="absolute right-0.5 top-0.5 size-5 rounded-full bg-white shadow-sm" />
                </div>
              </div>
              <div className="mt-4 grid grid-cols-3 gap-4 rounded-lg bg-white/[0.03] px-8 py-5">
                <div className="h-14 rounded-sm bg-gradient-to-b from-sky-300 to-violet-400">
                  <div className="ml-auto mr-2 mt-1 h-1.5 w-5 rounded-full bg-white/80" />
                </div>
                <div className="h-14 rounded-sm bg-gradient-to-b from-sky-300 to-violet-400">
                  <div className="ml-auto mr-2 mt-1 h-1.5 w-5 rounded-full bg-white/80" />
                  <div className="ml-auto mr-2 mt-2 h-1.5 w-6 rounded-full bg-white/80" />
                  <div className="ml-auto mr-2 mt-1 h-1.5 w-6 rounded-full bg-white/80" />
                </div>
                <div className="h-14 rounded-sm bg-gradient-to-b from-sky-300 to-violet-400">
                  <div className="mr-2 mt-1 text-right text-[10px] font-medium text-white/90">
                    9:41
                  </div>
                </div>
              </div>
              <div className="mt-3 flex justify-end">
                <button
                  type="button"
                  className="inline-flex items-center gap-1 text-xs font-medium text-white/60 hover:text-white"
                  onClick={() => setShowMacSettingsPreview(false)}
                >
                  <X className="size-3.5" />
                  Dismiss
                </button>
              </div>
            </div>
          ) : null}
        </section>
      ) : null}

      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="space-y-1">
            <h2 className="text-sm font-semibold text-foreground">Choose a sound</h2>
            <p className="text-[13px] leading-relaxed text-muted-foreground">
              Pick the alert Orca plays after a desktop notification is delivered.
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="gap-2"
            onClick={() => void handleSendTestNotification()}
          >
            <BellRing className="size-3.5" />
            Send Test Notification
          </Button>
        </div>

        <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
          {soundOptions.map((option) => {
            const selected = selectedSoundId === option.id
            const OptionIcon = option.icon
            return (
              <button
                key={option.id}
                type="button"
                aria-pressed={selected}
                className={cn(
                  'group relative flex min-h-14 items-center gap-3 overflow-hidden rounded-xl border p-3 text-left transition-all',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
                  selected
                    ? 'border-violet-500/60 bg-violet-500/10 text-foreground ring-2 ring-violet-500/30'
                    : 'border-border bg-muted/20 text-muted-foreground hover:bg-muted/40'
                )}
                onClick={() => void handleChooseBuiltInSound(option.id)}
              >
                <span className="grid size-5 shrink-0 place-items-center text-muted-foreground">
                  <OptionIcon className="size-4" />
                </span>
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
                  {option.title}
                </span>
                {selected ? (
                  <span
                    aria-hidden
                    className="grid size-5 shrink-0 place-items-center rounded-full bg-violet-500 text-white shadow-sm"
                  >
                    <Check className="size-3" strokeWidth={3} />
                  </span>
                ) : null}
              </button>
            )
          })}
        </div>

        {canAdjustVolume ? (
          <div className="rounded-lg border border-border bg-muted/20 px-4 py-3">
            <div className="flex items-center gap-3">
              <Volume2 className="size-4 text-muted-foreground" />
              <Slider
                value={[volumeDraft]}
                min={0}
                max={100}
                step={5}
                onValueChange={([value]) => setVolumeDraft(value)}
                onValueCommit={([value]) => handleVolumeCommit(value)}
                className="flex-1"
                aria-label="Notification sound volume"
              />
              <span className="w-10 text-right font-mono text-xs tabular-nums text-muted-foreground">
                {volumeDraft}%
              </span>
            </div>
          </div>
        ) : null}
      </section>

      <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="flex items-center gap-2 text-sm font-medium text-muted-foreground hover:text-foreground"
          >
            <ChevronDown
              className={cn('size-4 transition-transform', advancedOpen && 'rotate-180')}
            />
            Advanced sound file
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="mt-3 rounded-lg border border-border bg-muted/20 px-4 py-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0 space-y-1">
                <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                  <FileAudio className="size-4" />
                  Upload a sound
                </div>
                <p className="text-xs text-muted-foreground">
                  MP3, WAV, OGG, M4A, AAC, or FLAC. Orca stores only the local file path.
                </p>
                {customPath ? (
                  <p className="truncate font-mono text-[11px] text-muted-foreground">
                    {customPath}
                  </p>
                ) : null}
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="gap-2"
                disabled={isPickingSound}
                onClick={() => void handleChooseCustomSound()}
              >
                <Upload className="size-3.5" />
                {customPath ? 'Change File' : 'Choose File'}
              </Button>
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}
