import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  Accessibility,
  Bluetooth,
  Camera,
  ExternalLink,
  HardDrive,
  Mic,
  MonitorUp,
  Network,
  RefreshCw,
  ShieldCheck,
  Usb,
  Workflow
} from 'lucide-react'
import { toast } from 'sonner'
import type {
  DeveloperPermissionId,
  DeveloperPermissionState,
  DeveloperPermissionStatus
} from '../../../../shared/developer-permissions-types'
import { Button } from '../ui/button'
import type { SettingsSearchEntry } from './settings-search'

export const DEVELOPER_PERMISSIONS_PANE_SEARCH_ENTRIES: SettingsSearchEntry[] = [
  {
    title: 'Developer Permissions',
    description: 'macOS permissions for terminal-launched developer tools.',
    keywords: ['permissions', 'privacy', 'tcc', 'macos', 'developer tools']
  },
  {
    title: 'Microphone and Camera',
    description: 'Allow voice, transcription, webcam, and media capture tools.',
    keywords: ['microphone', 'camera', 'voice', 'audio', 'video', 'sox', 'ffmpeg', 'whisper']
  },
  {
    title: 'Screen Recording and Accessibility',
    description: 'Allow screenshots, screen inspection, keystrokes, and window automation.',
    keywords: ['screen recording', 'accessibility', 'screenshot', 'automation', 'window']
  },
  {
    title: 'Full Disk Access',
    description: 'Open the macOS privacy pane for broad terminal file access.',
    keywords: ['full disk access', 'documents', 'downloads', 'desktop', 'icloud']
  },
  {
    title: 'Local Network, USB, and Bluetooth',
    description: 'Allow device and local-network tools used from terminal sessions.',
    keywords: ['local network', 'usb', 'bluetooth', 'bonjour', 'mdns', 'device']
  }
]

type PermissionDefinition = {
  id: DeveloperPermissionId
  label: string
  description: string
  actionLabel: string
  icon: ReactNode
}

const PERMISSIONS: PermissionDefinition[] = [
  {
    id: 'microphone',
    label: 'Microphone',
    description: 'Voice input, transcription, audio recording, sox, ffmpeg, and Whisper CLIs.',
    actionLabel: 'Request',
    icon: <Mic className="size-4" />
  },
  {
    id: 'camera',
    label: 'Camera',
    description: 'Webcam capture and camera-driven local test apps.',
    actionLabel: 'Request',
    icon: <Camera className="size-4" />
  },
  {
    id: 'screen',
    label: 'Screen Recording',
    description: 'Screenshot, visual automation, and UI inspection tools.',
    actionLabel: 'Open Settings',
    icon: <MonitorUp className="size-4" />
  },
  {
    id: 'accessibility',
    label: 'Accessibility',
    description: 'Keystroke injection, window control, and UI automation tools.',
    actionLabel: 'Request',
    icon: <Accessibility className="size-4" />
  },
  {
    id: 'full-disk-access',
    label: 'Full Disk Access',
    description: 'Persistent access to protected folders from terminal sessions.',
    actionLabel: 'Open Settings',
    icon: <HardDrive className="size-4" />
  },
  {
    id: 'automation',
    label: 'Automation',
    description: 'Apple Events for scripts that control other local apps.',
    actionLabel: 'Trigger Prompt',
    icon: <Workflow className="size-4" />
  },
  {
    id: 'local-network',
    label: 'Local Network',
    description: 'Discovery and access for development servers on your network.',
    actionLabel: 'Trigger Prompt',
    icon: <Network className="size-4" />
  },
  {
    id: 'usb',
    label: 'USB Devices',
    description: 'Hardware debugging and device tools that talk to USB devices.',
    actionLabel: 'Open Settings',
    icon: <Usb className="size-4" />
  },
  {
    id: 'bluetooth',
    label: 'Bluetooth',
    description: 'Bluetooth device tools and local hardware experiments.',
    actionLabel: 'Open Settings',
    icon: <Bluetooth className="size-4" />
  }
]

function statusLabel(status: DeveloperPermissionStatus | undefined): string {
  switch (status) {
    case 'granted':
      return 'Granted'
    case 'denied':
      return 'Denied'
    case 'not-determined':
      return 'Not requested'
    case 'restricted':
      return 'Restricted'
    case 'unsupported':
      return 'macOS only'
    case 'ready':
      return 'Entitled'
    case 'unknown':
    default:
      return 'Check manually'
  }
}

function statusClass(status: DeveloperPermissionStatus | undefined): string {
  if (status === 'granted' || status === 'ready') {
    return 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
  }
  if (status === 'denied' || status === 'restricted') {
    return 'border-destructive/30 bg-destructive/10 text-destructive'
  }
  return 'border-border bg-muted text-muted-foreground'
}

export function DeveloperPermissionsPane(): React.JSX.Element {
  const [states, setStates] = useState<DeveloperPermissionState[]>([])
  const [loading, setLoading] = useState(true)
  const [pendingId, setPendingId] = useState<DeveloperPermissionId | null>(null)

  const stateById = useMemo(
    () => new Map(states.map((state) => [state.id, state.status] as const)),
    [states]
  )

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      setStates(await window.api.developerPermissions.getStatus())
    } catch {
      toast.error('Could not load developer permissions')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // Why: after the user flips a permission in System Settings and switches
  // back to Orca, the chip should reflect the new status without a manual
  // Refresh click. Tied to window focus rather than a polling interval so
  // we don't keep hammering `systemPreferences` while the pane is idle.
  useEffect(() => {
    const onFocus = (): void => {
      void refresh()
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refresh])

  const request = async (id: DeveloperPermissionId): Promise<void> => {
    setPendingId(id)
    try {
      const result = await window.api.developerPermissions.request({ id })
      await refresh()
      if (result.status === 'granted') {
        toast.success('Permission granted')
      } else if (result.openedSystemSettings) {
        toast.message('Opened macOS Privacy & Security')
      } else {
        toast.message('Permission request sent')
      }
    } catch {
      toast.error('Could not request permission')
    } finally {
      setPendingId(null)
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4 rounded-lg border border-border/60 bg-muted/25 px-4 py-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-sm font-medium">
            <ShieldCheck className="size-4" />
            Terminal tools inherit Orca&apos;s macOS privacy envelope.
          </div>
          <p className="text-xs text-muted-foreground">
            Use these controls when a CLI, local app, or automation tool needs macOS privacy access.
            Orca does not ask at startup.
          </p>
        </div>
        <Button variant="outline" size="sm" className="gap-1.5" onClick={() => void refresh()}>
          <RefreshCw className={`size-3.5 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
      </div>

      <div className="divide-y divide-border/60 rounded-lg border border-border/60">
        {PERMISSIONS.map((permission) => {
          const status = stateById.get(permission.id)
          const pending = pendingId === permission.id

          return (
            <div key={permission.id} className="flex items-center justify-between gap-4 px-4 py-3">
              <div className="flex min-w-0 items-start gap-3">
                <div className="mt-0.5 text-muted-foreground">{permission.icon}</div>
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">{permission.label}</span>
                    <span
                      className={`rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ${statusClass(
                        status
                      )}`}
                    >
                      {statusLabel(status)}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground">{permission.description}</p>
                </div>
              </div>
              <Button
                variant="outline"
                size="sm"
                disabled={pending || status === 'unsupported'}
                onClick={() => void request(permission.id)}
                className="shrink-0 gap-1.5"
              >
                <ExternalLink className="size-3.5" />
                {pending ? 'Working...' : permission.actionLabel}
              </Button>
            </div>
          )
        })}
      </div>
    </div>
  )
}
