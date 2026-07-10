import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, ExternalLink, HardDrive, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import type {
  DeveloperPermissionId,
  DeveloperPermissionState,
  DeveloperPermissionStatus
} from '../../../../shared/developer-permissions-types'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useMountedRef } from '@/hooks/useMountedRef'
import { isMacUserAgent } from '../terminal-pane/pane-helpers'
import { translate } from '@/i18n/i18n'

type FullDiskAccessStatusState = {
  status: DeveloperPermissionStatus | undefined
  checking: boolean
}

type FullDiskAccessButtonState = {
  ready: boolean
  requesting: boolean
}

const FULL_DISK_ACCESS_PERMISSION_ID: DeveloperPermissionId = 'full-disk-access'

export function isFullDiskAccessSetupVisible(
  status: DeveloperPermissionStatus | undefined
): boolean {
  return status !== undefined && status !== 'unsupported'
}

export function isFullDiskAccessReady(status: DeveloperPermissionStatus | undefined): boolean {
  return status === 'granted' || status === 'ready'
}

function getFullDiskAccessStatus(
  states: readonly DeveloperPermissionState[]
): DeveloperPermissionStatus | undefined {
  return states.find((state) => state.id === FULL_DISK_ACCESS_PERMISSION_ID)?.status
}

function getFullDiskAccessStatusLabel(args: FullDiskAccessStatusState): string {
  if (args.checking) {
    return translate(
      'auto.components.feature.wall.FullDiskAccessSetupPrompt.bbb3f1e404',
      'Checking'
    )
  }
  if (isFullDiskAccessReady(args.status)) {
    return translate('auto.components.feature.wall.FullDiskAccessSetupPrompt.48d87edcd2', 'Granted')
  }
  return translate(
    'auto.components.feature.wall.FullDiskAccessSetupPrompt.6db9a69f4e',
    'Recommended'
  )
}

function getFullDiskAccessButtonLabel(args: FullDiskAccessButtonState): string {
  if (args.requesting) {
    return translate(
      'auto.components.feature.wall.FullDiskAccessSetupPrompt.dac08ec03e',
      'Opening...'
    )
  }
  if (args.ready) {
    return translate('auto.components.feature.wall.FullDiskAccessSetupPrompt.48d87edcd2', 'Granted')
  }
  return translate(
    'auto.components.feature.wall.FullDiskAccessSetupPrompt.6e3d62b816',
    'Open Full Disk Access'
  )
}

function FullDiskAccessButtonIcon(props: FullDiskAccessButtonState): React.JSX.Element {
  if (props.requesting) {
    return <Loader2 className="size-3.5 animate-spin" />
  }
  if (props.ready) {
    return <Check className="size-3.5" />
  }
  return <ExternalLink className="size-3.5" />
}

function useFullDiskAccessStatus(): FullDiskAccessStatusState & { refresh: () => void } {
  const isMac = isMacUserAgent()
  const mountedRef = useMountedRef()
  const refreshSequenceRef = useRef(0)
  const [state, setState] = useState<FullDiskAccessStatusState>({
    status: undefined,
    checking: isMac
  })

  const finishRefresh = useCallback(
    (status: DeveloperPermissionStatus | undefined): void => {
      if (!mountedRef.current) {
        return
      }
      setState((current) =>
        current.status === status && !current.checking ? current : { status, checking: false }
      )
    },
    [mountedRef]
  )

  const refresh = useCallback((): void => {
    if (!isMac) {
      finishRefresh('unsupported')
      return
    }
    if (mountedRef.current) {
      setState((current) => (current.checking ? current : { ...current, checking: true }))
    }
    const refreshId = ++refreshSequenceRef.current
    window.api.developerPermissions
      .getStatus()
      .then((states) => {
        if (refreshId === refreshSequenceRef.current) {
          finishRefresh(getFullDiskAccessStatus(states))
        }
      })
      .catch(() => {
        if (refreshId === refreshSequenceRef.current) {
          finishRefresh(undefined)
        }
      })
  }, [finishRefresh, isMac, mountedRef])

  useEffect(() => {
    const refreshIfLive = (): void => {
      if (mountedRef.current) {
        refresh()
      }
    }
    refreshIfLive()
    if (!isMac) {
      return
    }
    // Why: users grant Full Disk Access outside Orca, so focus is the first
    // cheap signal that System Settings may have changed the permission state.
    window.addEventListener('focus', refreshIfLive)
    return () => {
      window.removeEventListener('focus', refreshIfLive)
    }
  }, [isMac, mountedRef, refresh])

  return { ...state, refresh }
}

export function FullDiskAccessSetupPrompt(): React.JSX.Element | null {
  const { checking, refresh, status } = useFullDiskAccessStatus()
  const mountedRef = useMountedRef()
  const [requesting, setRequesting] = useState(false)
  const ready = isFullDiskAccessReady(status)
  const visible = checking || isFullDiskAccessSetupVisible(status)

  const handleOpenFullDiskAccess = useCallback(async (): Promise<void> => {
    setRequesting(true)
    try {
      const result = await window.api.developerPermissions.request({
        id: FULL_DISK_ACCESS_PERMISSION_ID
      })
      if (!mountedRef.current) {
        return
      }
      refresh()
      if (result.status === 'granted') {
        toast.success(
          translate('auto.components.feature.wall.FullDiskAccessSetupPrompt.48d87edcd2', 'Granted')
        )
      } else if (result.openedSystemSettings) {
        toast.message(
          translate(
            'auto.components.feature.wall.FullDiskAccessSetupPrompt.fa809e8ada',
            'Opened macOS Privacy & Security'
          )
        )
      }
    } catch {
      toast.error(
        translate(
          'auto.components.feature.wall.FullDiskAccessSetupPrompt.bfa3402305',
          'Could not request permission'
        )
      )
    } finally {
      if (mountedRef.current) {
        setRequesting(false)
      }
    }
  }, [mountedRef, refresh])

  if (!visible) {
    return null
  }

  return (
    <div className="mt-5 flex items-center justify-between gap-4 rounded-lg border border-border/60 bg-muted/20 px-4 py-3">
      <div className="flex min-w-0 items-start gap-3">
        <div className="mt-0.5 text-muted-foreground">
          <HardDrive className="size-4" />
        </div>
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-foreground">
              {translate(
                'auto.components.feature.wall.FullDiskAccessSetupPrompt.c566bca278',
                'Full Disk Access'
              )}
            </span>
            <Badge variant={ready ? 'secondary' : 'outline'} className="uppercase tracking-wider">
              {getFullDiskAccessStatusLabel({ checking, status })}
            </Badge>
          </div>
          <p className="text-xs leading-snug text-muted-foreground">
            {translate(
              'auto.components.feature.wall.FullDiskAccessSetupPrompt.0d6efe9cf4',
              'Recommended on macOS when projects or worktrees live in protected folders.'
            )}
          </p>
        </div>
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="shrink-0 gap-1.5"
        disabled={ready || requesting || checking}
        onClick={() => void handleOpenFullDiskAccess()}
      >
        <FullDiskAccessButtonIcon ready={ready} requesting={requesting} />
        {getFullDiskAccessButtonLabel({ ready, requesting })}
      </Button>
    </div>
  )
}
