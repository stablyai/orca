import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
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
import { translate } from '@/i18n/i18n'
export { getDeveloperPermissionsPaneSearchEntries } from './developer-permissions-search'

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
    get label() {
      return translate('auto.components.settings.DeveloperPermissionsPane.16381e040a', 'Microphone')
    },
    get description() {
      return translate(
        'auto.components.settings.DeveloperPermissionsPane.cc8151d9fa',
        'Voice input, transcription, audio recording, sox, ffmpeg, and Whisper CLIs.'
      )
    },
    actionLabel: 'Request',
    icon: <Mic className="size-4" />
  },
  {
    id: 'camera',
    get label() {
      return translate('auto.components.settings.DeveloperPermissionsPane.e5b5f3d6b9', 'Camera')
    },
    get description() {
      return translate(
        'auto.components.settings.DeveloperPermissionsPane.550cfa3750',
        'Webcam capture and camera-driven local test apps.'
      )
    },
    actionLabel: 'Request',
    icon: <Camera className="size-4" />
  },
  {
    id: 'screen',
    get label() {
      return translate(
        'auto.components.settings.DeveloperPermissionsPane.f24f31a884',
        'Screen Recording'
      )
    },
    get description() {
      return translate(
        'auto.components.settings.DeveloperPermissionsPane.0639db5496',
        'Screenshot, visual automation, and UI inspection tools.'
      )
    },
    actionLabel: 'Open Settings',
    icon: <MonitorUp className="size-4" />
  },
  {
    id: 'accessibility',
    get label() {
      return translate(
        'auto.components.settings.DeveloperPermissionsPane.5b2f22ca2d',
        'Accessibility'
      )
    },
    get description() {
      return translate(
        'auto.components.settings.DeveloperPermissionsPane.9f35980756',
        'Keystroke injection, window control, and UI automation tools.'
      )
    },
    actionLabel: 'Request',
    icon: <Accessibility className="size-4" />
  },
  {
    id: 'full-disk-access',
    get label() {
      return translate(
        'auto.components.settings.DeveloperPermissionsPane.c566bca278',
        'Full Disk Access'
      )
    },
    get description() {
      return translate(
        'auto.components.settings.DeveloperPermissionsPane.7ca17b62c8',
        'Recommended when projects, worktrees, or symlinked files touch macOS-protected folders.'
      )
    },
    actionLabel: 'Open Settings',
    icon: <HardDrive className="size-4" />
  },
  {
    id: 'automation',
    get label() {
      return translate('auto.components.settings.DeveloperPermissionsPane.e119f0d66b', 'Automation')
    },
    get description() {
      return translate(
        'auto.components.settings.DeveloperPermissionsPane.4a73f5217a',
        'Apple Events for scripts that control other local apps.'
      )
    },
    actionLabel: 'Trigger Prompt',
    icon: <Workflow className="size-4" />
  },
  {
    id: 'local-network',
    get label() {
      return translate(
        'auto.components.settings.DeveloperPermissionsPane.e7bb06007c',
        'Local Network'
      )
    },
    get description() {
      return translate(
        'auto.components.settings.DeveloperPermissionsPane.f903bf20b5',
        'Discovery and access for development servers on your network.'
      )
    },
    actionLabel: 'Trigger Prompt',
    icon: <Network className="size-4" />
  },
  {
    id: 'usb',
    get label() {
      return translate(
        'auto.components.settings.DeveloperPermissionsPane.bf51e4a542',
        'USB Devices'
      )
    },
    get description() {
      return translate(
        'auto.components.settings.DeveloperPermissionsPane.dfbc12c8c8',
        'Hardware debugging and device tools that talk to USB devices.'
      )
    },
    actionLabel: 'Open Settings',
    icon: <Usb className="size-4" />
  },
  {
    id: 'bluetooth',
    get label() {
      return translate('auto.components.settings.DeveloperPermissionsPane.b2210b1b4f', 'Bluetooth')
    },
    get description() {
      return translate(
        'auto.components.settings.DeveloperPermissionsPane.4cfaa7e98a',
        'Bluetooth device tools and local hardware experiments.'
      )
    },
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
    case undefined:
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
  const mountedRef = useRef(true)
  const refreshSequenceRef = useRef(0)

  const stateById = useMemo(
    () => new Map(states.map((state) => [state.id, state.status] as const)),
    [states]
  )

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      refreshSequenceRef.current += 1
    }
  }, [])

  const refresh = useCallback(async (): Promise<void> => {
    const refreshId = refreshSequenceRef.current + 1
    refreshSequenceRef.current = refreshId
    setLoading(true)
    try {
      const nextStates = await window.api.developerPermissions.getStatus()
      if (mountedRef.current && refreshId === refreshSequenceRef.current) {
        setStates(nextStates)
      }
    } catch {
      if (mountedRef.current && refreshId === refreshSequenceRef.current) {
        toast.error(
          translate(
            'auto.components.settings.DeveloperPermissionsPane.a552887288',
            'Could not load developer permissions'
          )
        )
      }
    } finally {
      if (mountedRef.current && refreshId === refreshSequenceRef.current) {
        setLoading(false)
      }
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
      if (!mountedRef.current) {
        return
      }
      await refresh()
      if (!mountedRef.current) {
        return
      }
      if (result.status === 'granted') {
        toast.success(
          translate(
            'auto.components.settings.DeveloperPermissionsPane.48d87edcd2',
            'Permission granted'
          )
        )
      } else if (result.openedSystemSettings) {
        toast.message(
          translate(
            'auto.components.settings.DeveloperPermissionsPane.fa809e8ada',
            'Opened macOS Privacy & Security'
          )
        )
      } else {
        toast.message(
          translate(
            'auto.components.settings.DeveloperPermissionsPane.66e94d6cf3',
            'Permission request sent'
          )
        )
      }
    } catch {
      if (mountedRef.current) {
        toast.error(
          translate(
            'auto.components.settings.DeveloperPermissionsPane.bfa3402305',
            'Could not request permission'
          )
        )
      }
    } finally {
      if (mountedRef.current) {
        setPendingId(null)
      }
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4 rounded-lg border border-border/60 bg-muted/25 px-4 py-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-sm font-medium">
            <ShieldCheck className="size-4" />
            {translate(
              'auto.components.settings.DeveloperPermissionsPane.6f011b9bf6',
              "Terminal tools inherit Orca's macOS privacy envelope."
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.DeveloperPermissionsPane.6326a4c5cc',
              'Use these controls when a CLI, local app, or automation tool needs macOS privacy access. Orca does not ask at startup.'
            )}
          </p>
        </div>
        <Button variant="outline" size="sm" className="gap-1.5" onClick={() => void refresh()}>
          <RefreshCw className={`size-3.5 ${loading ? 'animate-spin' : ''}`} />
          {translate('auto.components.settings.DeveloperPermissionsPane.4c17304beb', 'Refresh')}
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
                {pending
                  ? translate(
                      'auto.components.settings.DeveloperPermissionsPane.dac08ec03e',
                      'Working...'
                    )
                  : permission.actionLabel}
              </Button>
            </div>
          )
        })}
      </div>
    </div>
  )
}
