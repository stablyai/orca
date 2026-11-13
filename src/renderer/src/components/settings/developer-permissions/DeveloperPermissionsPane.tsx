import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  Accessibility,
  Bluetooth,
  Camera,
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
  DeveloperPermissionState
} from '../../../../../shared/developer-permissions-types'
import { Button } from '../../ui/button'
import { translate } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import { DeveloperPermissionActions } from './DeveloperPermissionActions'
import { LocalNetworkConnectionTest } from './LocalNetworkConnectionTest'
import {
  developerPermissionStatusClass,
  developerPermissionStatusLabel
} from './developer-permission-status'
import { showDeveloperPermissionRequestNotice } from './developer-permission-request-notice'
import { TerminalTccAttributionNotice } from './TerminalTccAttributionNotice'
import { SETTINGS_GROUP_ROW_BLEED_CLASS, SettingsGroup } from '../section-layout/SettingsGroup'
import { cn } from '@/lib/class-names'

type DeveloperPermissionsPaneProps = {
  highlightedSettingId?: string | null
}

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
    get actionLabel() {
      return translate('auto.components.settings.DeveloperPermissionsPane.actionRequest', 'Request')
    },
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
    get actionLabel() {
      return translate('auto.components.settings.DeveloperPermissionsPane.actionRequest', 'Request')
    },
    icon: <Camera className="size-4" />
  },
  {
    id: 'screen',
    get label() {
      return translate(
        'auto.components.settings.DeveloperPermissionsPane.515baa0f5c',
        'Screen recording'
      )
    },
    get description() {
      return translate(
        'auto.components.settings.DeveloperPermissionsPane.0639db5496',
        'Screenshot, visual automation, and UI inspection tools.'
      )
    },
    get actionLabel() {
      return translate(
        'auto.components.settings.DeveloperPermissionsPane.b8cd05701d',
        'Open settings'
      )
    },
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
    get actionLabel() {
      return translate('auto.components.settings.DeveloperPermissionsPane.actionRequest', 'Request')
    },
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
        "macOS names Orca when the agents it runs read other apps' data, because Orca is the responsible process for terminal commands. Grant this to Orca to reduce those prompts. Then quit and reopen Orca."
      )
    },
    get actionLabel() {
      return translate(
        'auto.components.settings.DeveloperPermissionsPane.b8cd05701d',
        'Open settings'
      )
    },
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
    get actionLabel() {
      return translate(
        'auto.components.settings.DeveloperPermissionsPane.28350e590b',
        'Trigger prompt'
      )
    },
    icon: <Workflow className="size-4" />
  },
  {
    id: 'local-network',
    get label() {
      return translate(
        'auto.components.settings.DeveloperPermissionsPane.78b1e0b9d4',
        'Local network'
      )
    },
    get description() {
      return translate(
        'auto.components.settings.DeveloperPermissionsPane.f903bf20b5',
        "Allows terminals and development tools to connect to services on your local network. macOS does not report this permission's current status to Orca."
      )
    },
    get actionLabel() {
      return translate(
        'auto.components.settings.DeveloperPermissionsPane.e2596159f6',
        'Request access'
      )
    },
    icon: <Network className="size-4" />
  },
  {
    id: 'usb',
    get label() {
      return translate(
        'auto.components.settings.DeveloperPermissionsPane.91f887e323',
        'USB devices'
      )
    },
    get description() {
      return translate(
        'auto.components.settings.DeveloperPermissionsPane.dfbc12c8c8',
        'Hardware debugging and device tools that talk to USB devices.'
      )
    },
    get actionLabel() {
      return translate(
        'auto.components.settings.DeveloperPermissionsPane.b8cd05701d',
        'Open settings'
      )
    },
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
    get actionLabel() {
      return translate(
        'auto.components.settings.DeveloperPermissionsPane.b8cd05701d',
        'Open settings'
      )
    },
    icon: <Bluetooth className="size-4" />
  }
]

export function DeveloperPermissionsPane({
  highlightedSettingId = null
}: DeveloperPermissionsPaneProps): React.JSX.Element {
  const t = useTranslate()
  const [states, setStates] = useState<DeveloperPermissionState[]>([])
  const [loading, setLoading] = useState(true)
  const [pendingId, setPendingId] = useState<DeveloperPermissionId | null>(null)
  const mountedRef = useRef(true)
  const refreshSequenceRef = useRef(0)

  const stateById = useMemo(
    () => new Map(states.map((state) => [state.id, state] as const)),
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

  // Refresh after returning from System Settings so permission chips update without idle systemPreferences polling.
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
      showDeveloperPermissionRequestNotice(result, () => {
        void window.api.developerPermissions.openSettings({ id: 'local-network' })
      })
    } catch {
      if (mountedRef.current) {
        toast.error(
          t(
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
    <div className="space-y-8">
      <TerminalTccAttributionNotice />
      <SettingsGroup
        title={
          <span className="flex items-center gap-2">
            <ShieldCheck className="size-4" />
            {t(
              'auto.components.settings.DeveloperPermissionsPane.6f011b9bf6',
              "Terminal tools inherit Orca's macOS privacy envelope."
            )}
          </span>
        }
        description={t(
          'auto.components.settings.DeveloperPermissionsPane.6326a4c5cc',
          'Use these controls when a CLI, local app, or automation tool needs macOS privacy access. Orca does not ask at startup.'
        )}
        action={
          <Button variant="outline" size="sm" className="gap-1.5" onClick={() => void refresh()}>
            <RefreshCw className={`size-3.5 ${loading ? 'animate-spin' : ''}`} />
            {t('auto.components.settings.DeveloperPermissionsPane.4c17304beb', 'Refresh')}
          </Button>
        }
      >
        {PERMISSIONS.map((permission) => {
          const state = stateById.get(permission.id)
          const status = state?.status
          const pending = pendingId === permission.id
          const settingId = `developer-permissions-${permission.id}`

          return (
            <div key={permission.id} data-settings-row="">
              <div
                data-settings-section={settingId}
                data-highlighted={highlightedSettingId === settingId ? 'true' : undefined}
                className={cn(
                  SETTINGS_GROUP_ROW_BLEED_CLASS,
                  'flex items-center justify-between gap-4 py-3 transition-[background-color,box-shadow] duration-500 data-[highlighted=true]:bg-accent data-[highlighted=true]:ring-2 data-[highlighted=true]:ring-inset data-[highlighted=true]:ring-ring/50 motion-reduce:transition-none'
                )}
              >
                <div className="flex min-w-0 items-start gap-3">
                  <div className="mt-0.5 text-muted-foreground">{permission.icon}</div>
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium">{permission.label}</span>
                      <span
                        className={`rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider ${developerPermissionStatusClass(
                          status
                        )}`}
                      >
                        {permission.id === 'full-disk-access' &&
                          t('auto.components.settings.DeveloperPermissionsPane.appStatus', 'App: ')}
                        {developerPermissionStatusLabel(permission.id, status, t)}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground">{permission.description}</p>
                    {permission.id === 'full-disk-access' && state?.terminalHostStatus && (
                      <p className="text-xs text-muted-foreground">
                        {t(
                          'auto.components.settings.DeveloperPermissionsPane.terminalHostStatus',
                          'Terminal hosts: '
                        )}
                        {developerPermissionStatusLabel(permission.id, state.terminalHostStatus, t)}
                        {state.terminalHostStatus !== 'granted' && (
                          <>
                            {' '}
                            {t(
                              'auto.components.settings.DeveloperPermissionsPane.terminalHostRecovery',
                              'If a terminal cannot read protected files, save its work and close it in Terminal → Manage Sessions. Restart the daemon if new terminals are also affected; restarting closes its current terminals.'
                            )}
                          </>
                        )}
                      </p>
                    )}
                  </div>
                </div>
                <DeveloperPermissionActions
                  id={permission.id}
                  actionLabel={permission.actionLabel}
                  pending={pending}
                  status={status}
                  onRequest={(id) => void request(id)}
                />
              </div>
              {permission.id === 'local-network' && <LocalNetworkConnectionTest />}
            </div>
          )
        })}
      </SettingsGroup>
    </div>
  )
}
