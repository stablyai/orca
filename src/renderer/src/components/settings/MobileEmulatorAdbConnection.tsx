import { useEffect, useId, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { cn } from '@/lib/utils'
import { callRuntimeRpc, RuntimeRpcCallError } from '@/runtime/runtime-rpc-client'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import {
  resolveAdbDefaultHygieneSerial,
  shouldClearAdbDefaultDevice
} from './mobile-emulator-adb-default-device-hygiene'
import { translate } from '@/i18n/i18n'

// Renderer-safe mirror of src/main/emulator/android/adb-device-connection.ts —
// that module is main-process only (adb process I/O), so the shape is
// duplicated here the same way EmulatorAvailability is in the sibling pane.
type AdbConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'unauthorized'
  | 'offline'
  | 'failed'

type AdbConnectionStatus = {
  state: AdbConnectionState
  address: string | null
  serial: string | null
  message?: string
  errorCode?: string
}

type MobileEmulatorAdbConnectionProps = {
  settings: Pick<GlobalSettings, 'mobileEmulatorAdbAddress' | 'mobileEmulatorDefaultDeviceUdid'>
  updateSettings: (updates: Partial<GlobalSettings>) => void
  disabled?: boolean
  // Why: the pane already owns availability polling; this component reuses it
  // instead of duplicating a second availability fetch.
  onAfterConnectionChange: () => void | Promise<void>
}

function statusLabel(state: AdbConnectionState | 'unsupported'): string {
  switch (state) {
    case 'connected':
      return translate(
        'auto.components.settings.MobileEmulatorAdbConnection.bb9d5d8810',
        'Connected'
      )
    case 'connecting':
      return translate(
        'auto.components.settings.MobileEmulatorAdbConnection.f227da109f',
        'Connecting…'
      )
    case 'unauthorized':
      return translate(
        'auto.components.settings.MobileEmulatorAdbConnection.24e04bcc2d',
        'Unauthorized'
      )
    case 'offline':
      return translate('auto.components.settings.MobileEmulatorAdbConnection.87f10ea8c7', 'Offline')
    case 'failed':
      return translate('auto.components.settings.MobileEmulatorAdbConnection.ddc15ee405', 'Failed')
    case 'unsupported':
      return translate(
        'auto.components.settings.MobileEmulatorAdbConnection.4fdad1ea69',
        'Unavailable'
      )
    case 'disconnected':
      return translate(
        'auto.components.settings.MobileEmulatorAdbConnection.e2763f4f83',
        'Not connected'
      )
  }
}

function statusBadgeClassName(state: AdbConnectionState | 'unsupported'): string {
  if (state === 'connected') {
    return 'border-status-success-border bg-status-success-background text-status-success'
  }
  if (
    state === 'failed' ||
    state === 'unauthorized' ||
    state === 'offline' ||
    state === 'unsupported'
  ) {
    return 'border-destructive/30 bg-destructive/10 text-destructive'
  }
  return 'border-border/50 bg-muted/30 text-muted-foreground'
}

function isMethodNotFound(error: unknown): boolean {
  return error instanceof RuntimeRpcCallError && error.code === 'method_not_found'
}

function failedStatusFromError(address: string | null, error: unknown): AdbConnectionStatus {
  const message =
    error instanceof Error
      ? error.message
      : translate(
          'auto.components.settings.MobileEmulatorAdbConnection.bff8b67049',
          'Could not reach the ADB connection.'
        )
  const errorCode = error instanceof RuntimeRpcCallError ? error.code : undefined
  return { state: 'failed', address, serial: null, message, errorCode }
}

export function MobileEmulatorAdbConnection({
  settings,
  updateSettings,
  disabled = false,
  onAfterConnectionChange
}: MobileEmulatorAdbConnectionProps): React.JSX.Element {
  const inputId = useId()
  const savedAddress = settings.mobileEmulatorAdbAddress ?? ''
  const [draft, setDraft] = useState(savedAddress)
  const [prevSavedAddress, setPrevSavedAddress] = useState(savedAddress)
  const [status, setStatus] = useState<AdbConnectionStatus | null>(null)
  const [opKind, setOpKind] = useState<'status' | 'connect' | 'disconnect' | null>(null)
  const [unsupported, setUnsupported] = useState(false)
  const requestSeqRef = useRef(0)
  // Why: the last observed address/serial pair, used to decide whether
  // reassigning or dropping the address should also clear the default device
  // (mobile-emulator-adb-default-device-hygiene.ts owns the actual rule).
  const lastStatusRef = useRef<{ address: string | null; serial: string | null }>({
    address: null,
    serial: null
  })

  if (savedAddress !== prevSavedAddress) {
    setPrevSavedAddress(savedAddress)
    setDraft(savedAddress)
  }

  useEffect(() => {
    const seq = ++requestSeqRef.current
    const address = settings.mobileEmulatorAdbAddress ?? undefined
    setOpKind('status')
    void callRuntimeRpc<AdbConnectionStatus>({ kind: 'local' }, 'emulator.adbConnectionStatus', {
      address
    })
      .then((result) => {
        if (seq !== requestSeqRef.current) {
          return
        }
        lastStatusRef.current = { address: result.address, serial: result.serial }
        setStatus(result)
      })
      .catch((error: unknown) => {
        if (seq !== requestSeqRef.current) {
          return
        }
        if (isMethodNotFound(error)) {
          setUnsupported(true)
          return
        }
        setStatus(failedStatusFromError(address ?? null, error))
      })
      .finally(() => {
        if (seq === requestSeqRef.current) {
          setOpKind(null)
        }
      })
    // Why: mount-only passive check. Connect/Disconnect apply their own RPC
    // response directly instead of re-querying, so this must not re-fire on
    // every address edit (that would race the connect/disconnect request's
    // own sequence number).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const opInFlight = opKind !== null
  // Why: the background mount status check is passive and must not block the
  // user from acting on Connect/Disconnect while it's still settling — only
  // an actual mutation in flight disables the controls.
  const mutationInFlight = opKind === 'connect' || opKind === 'disconnect'
  const controlsDisabled = disabled || unsupported || mutationInFlight

  function commitAddressIfChanged(nextRaw: string): void {
    const next = nextRaw.trim()
    const previous = settings.mobileEmulatorAdbAddress ?? ''
    if (next === previous) {
      return
    }
    const previousSerial = resolveAdbDefaultHygieneSerial(lastStatusRef.current, previous || null)
    const updates: Partial<GlobalSettings> = { mobileEmulatorAdbAddress: next || null }
    if (shouldClearAdbDefaultDevice(settings.mobileEmulatorDefaultDeviceUdid, previousSerial)) {
      updates.mobileEmulatorDefaultDeviceUdid = null
    }
    updateSettings(updates)
  }

  async function runOp(
    kind: 'connect' | 'disconnect',
    call: (address: string) => Promise<AdbConnectionStatus>,
    address: string
  ): Promise<void> {
    const seq = ++requestSeqRef.current
    setOpKind(kind)
    try {
      const result = await call(address)
      if (seq !== requestSeqRef.current) {
        return
      }
      lastStatusRef.current = { address: result.address, serial: result.serial }
      setStatus(result)
    } catch (error) {
      if (seq !== requestSeqRef.current) {
        return
      }
      if (isMethodNotFound(error)) {
        setUnsupported(true)
      } else {
        setStatus(failedStatusFromError(address, error))
      }
    } finally {
      if (seq === requestSeqRef.current) {
        setOpKind(null)
      }
      await onAfterConnectionChange()
    }
  }

  function handleConnect(): void {
    const address = draft.trim()
    if (!address) {
      setStatus({
        state: 'failed',
        address: null,
        serial: null,
        message: translate(
          'auto.components.settings.MobileEmulatorAdbConnection.40a48c3a86',
          'Enter a device address first.'
        )
      })
      return
    }
    commitAddressIfChanged(address)
    void runOp(
      'connect',
      (value) =>
        callRuntimeRpc<AdbConnectionStatus>({ kind: 'local' }, 'emulator.adbConnect', {
          address: value
        }),
      address
    )
  }

  function handleDisconnect(): void {
    const address = settings.mobileEmulatorAdbAddress ?? status?.address
    if (!address) {
      return
    }
    const previousSerial = resolveAdbDefaultHygieneSerial(lastStatusRef.current, address)
    if (shouldClearAdbDefaultDevice(settings.mobileEmulatorDefaultDeviceUdid, previousSerial)) {
      updateSettings({ mobileEmulatorDefaultDeviceUdid: null })
    }
    void runOp(
      'disconnect',
      (value) =>
        callRuntimeRpc<AdbConnectionStatus>({ kind: 'local' }, 'emulator.adbDisconnect', {
          address: value
        }),
      address
    )
  }

  // Why: the connect RPC blocks until a final status, so the server never
  // emits an intermediate 'connecting' state — show it optimistically here
  // while that one call is in flight.
  const effectiveState: AdbConnectionState | 'unsupported' = unsupported
    ? 'unsupported'
    : opKind === 'connect'
      ? 'connecting'
      : (status?.state ?? 'disconnected')

  return (
    <div className="py-2">
      <div className="flex items-start gap-4">
        <div className="min-w-0 flex-1 space-y-0.5">
          <Label>
            {translate(
              'auto.components.settings.MobileEmulatorAdbConnection.4f9f7d7949',
              'ADB Device Connection'
            )}
          </Label>
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.MobileEmulatorAdbConnection.429d1ea0c4',
              'Connect an Android device or cloud phone over ADB (host:port). The address must already be reachable from this computer; VPN/tunnel setup is a separate step.'
            )}
          </p>
        </div>
        <Badge
          variant="outline"
          className={cn('shrink-0 text-[11px]', statusBadgeClassName(effectiveState))}
        >
          {opInFlight ? <Loader2 className="size-3 animate-spin" /> : null}
          {statusLabel(effectiveState)}
        </Badge>
      </div>

      {unsupported ? (
        <p className="mt-2 text-xs text-muted-foreground" role="status" aria-live="polite">
          {translate(
            'auto.components.settings.MobileEmulatorAdbConnection.05a99b8deb',
            'ADB device connection is not available from this client.'
          )}
        </p>
      ) : (
        <>
          <div className="mt-3 flex flex-wrap items-end gap-2">
            <div className="min-w-0 flex-1 space-y-1">
              <Label htmlFor={inputId} className="text-xs text-muted-foreground">
                {translate(
                  'auto.components.settings.MobileEmulatorAdbConnection.8c92f2f5f2',
                  'Device address'
                )}
              </Label>
              <Input
                id={inputId}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={(e) => commitAddressIfChanged(e.target.value)}
                placeholder="192.168.1.50:5555"
                disabled={controlsDisabled}
                className="w-56 max-w-full"
              />
            </div>
            <Button
              type="button"
              size="sm"
              onClick={handleConnect}
              disabled={controlsDisabled || draft.trim().length === 0}
            >
              {translate(
                'auto.components.settings.MobileEmulatorAdbConnection.215612d345',
                'Connect'
              )}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={handleDisconnect}
              disabled={controlsDisabled || !(settings.mobileEmulatorAdbAddress || status?.address)}
            >
              {translate(
                'auto.components.settings.MobileEmulatorAdbConnection.6f152886ba',
                'Disconnect'
              )}
            </Button>
          </div>

          <p
            className="mt-2 min-h-4 text-xs text-muted-foreground"
            role="status"
            aria-live="polite"
          >
            {status?.message ?? ''}
          </p>

          <p className="mt-1 text-[11px] text-muted-foreground">
            {translate(
              'auto.components.settings.MobileEmulatorAdbConnection.d92278bd52',
              'ADB grants shell, install, and debug access to the device — never expose it to an untrusted network.'
            )}
          </p>
        </>
      )}
    </div>
  )
}
