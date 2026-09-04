import { Home, PowerOff, RotateCw, Smartphone } from 'lucide-react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import type { SimulatorDeviceRow } from './emulator-pane-types'
import { translate } from '@/i18n/i18n'
import {
  AndroidEmulatorToolbarControls,
  type AndroidEmulatorToolbarControlsProps
} from './android-emulator-toolbar-controls'

type EmulatorPaneToolbarProps = {
  displayName: string
  isLive: boolean
  loading: boolean
  devices: SimulatorDeviceRow[]
  selectedUdid: string | null
  backend?: 'ios' | 'android'
  androidControls?: Omit<AndroidEmulatorToolbarControlsProps, 'disabled'>
  onSelectDevice: (udid: string) => void
  onAttach: () => void
  onShutdown: () => void
  onHome: () => void
  onRotate: () => void
}

export function EmulatorPaneToolbar({
  displayName,
  isLive,
  loading,
  devices,
  selectedUdid,
  backend,
  androidControls,
  onSelectDevice,
  onAttach,
  onShutdown,
  onHome,
  onRotate
}: EmulatorPaneToolbarProps) {
  // Why: the toolbar chip describes Orca's preview/control stream, not the
  // lower-level CoreSimulator boot state.
  const statusLabel = isLive ? 'Connected' : loading ? 'Working…' : 'Not connected'
  const subtleStatus = isLive || loading
  const statusClassName = subtleStatus
    ? 'text-muted-foreground'
    : 'border-border bg-muted text-muted-foreground'
  const isAndroid = backend === 'android'
  const selectedDevice = devices.find((device) => device.udid === selectedUdid)
  const canShutdown =
    !isAndroid ||
    (androidControls?.capabilities?.shutdown ?? selectedDevice?.runtime === 'emulator')
  const controlsDisabled = !isLive || loading

  return (
    <div className="@container/emulator-toolbar flex min-w-0 items-center gap-2 border-b border-border px-3 py-2">
      <Smartphone className="size-4 shrink-0 text-primary [@container(max-width:519px)]:hidden" />
      <span className="truncate font-medium [@container(max-width:519px)]:hidden">
        {displayName}
      </span>
      <span
        className={cn(
          'shrink-0 text-[11px] [@container(max-width:519px)]:hidden',
          !subtleStatus && 'rounded border px-1.5 py-0.5 text-[10px]',
          statusClassName
        )}
      >
        {statusLabel}
      </span>
      <Select
        value={selectedUdid ?? ''}
        onValueChange={onSelectDevice}
        disabled={loading || devices.length === 0}
      >
        <SelectTrigger className="h-7 min-w-0 flex-1 text-xs [@container(min-width:520px)]:max-w-[180px]">
          <SelectValue
            placeholder={translate(
              'auto.components.emulator.pane.emulator.pane.toolbar.3d836b879c',
              'Choose emulator'
            )}
          />
        </SelectTrigger>
        <SelectContent position="popper" side="bottom" align="start" sideOffset={4}>
          {devices.map((d) => (
            <SelectItem key={d.udid} value={d.udid} className="text-xs">
              {d.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {isAndroid && androidControls ? (
        <AndroidEmulatorToolbarControls {...androidControls} disabled={controlsDisabled} />
      ) : (
        <LegacyIosControls disabled={controlsDisabled} onHome={onHome} onRotate={onRotate} />
      )}

      {isLive && canShutdown ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 shrink-0 gap-1 px-2 text-xs text-muted-foreground hover:text-destructive"
              onClick={onShutdown}
              disabled={loading}
              aria-label={translate(
                'auto.components.emulator.pane.emulator.pane.toolbar.06e10d7356',
                'Shut down emulator'
              )}
            >
              <PowerOff className="size-3.5" />
              <span className="hidden [@container(min-width:768px)]:inline">
                {translate(
                  'auto.components.emulator.pane.emulator.pane.toolbar.06e10d7356',
                  'Shut down emulator'
                )}
              </span>
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={4}>
            {translate(
              'auto.components.emulator.pane.emulator.pane.toolbar.06e10d7356',
              'Shut down emulator'
            )}
          </TooltipContent>
        </Tooltip>
      ) : !isLive ? (
        <Button
          type="button"
          size="sm"
          variant={loading ? 'ghost' : 'default'}
          className={cn('h-7 shrink-0 px-2 text-xs', loading && 'text-muted-foreground')}
          onClick={onAttach}
          disabled={loading || devices.length === 0}
        >
          {loading
            ? translate(
                'auto.components.emulator.pane.emulator.pane.toolbar.868c0f2938',
                'Working…'
              )
            : translate(
                'auto.components.emulator.pane.emulator.pane.toolbar.81b3571a07',
                'Connect'
              )}
        </Button>
      ) : null}
    </div>
  )
}

function LegacyIosControls({
  disabled,
  onHome,
  onRotate
}: {
  disabled: boolean
  onHome: () => void
  onRotate: () => void
}) {
  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="h-7 shrink-0 gap-1 px-2 text-xs"
            onClick={onRotate}
            disabled={disabled}
            aria-label={translate(
              'auto.components.emulator.pane.emulator.pane.toolbar.6bd8dff42a',
              'Rotate'
            )}
          >
            <RotateCw className="size-3.5" />
            <span className="hidden [@container(min-width:520px)]:inline">
              {translate(
                'auto.components.emulator.pane.emulator.pane.toolbar.6bd8dff42a',
                'Rotate'
              )}
            </span>
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={4}>
          {translate('auto.components.emulator.pane.emulator.pane.toolbar.6bd8dff42a', 'Rotate')}
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="secondary"
            size="icon-xs"
            className="size-7 shrink-0"
            onClick={onHome}
            disabled={disabled}
            aria-label={translate(
              'auto.components.emulator.pane.emulator.pane.toolbar.e7a0d1897e',
              'Home'
            )}
          >
            <Home className="size-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={4}>
          {translate('auto.components.emulator.pane.emulator.pane.toolbar.e7a0d1897e', 'Home')}
        </TooltipContent>
      </Tooltip>
    </>
  )
}
