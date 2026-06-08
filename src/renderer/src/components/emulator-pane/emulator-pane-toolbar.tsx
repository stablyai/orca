import { Home, Power, RotateCw, Smartphone } from 'lucide-react'
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

type EmulatorPaneToolbarProps = {
  displayName: string
  isLive: boolean
  loading: boolean
  devices: SimulatorDeviceRow[]
  selectedUdid: string | null
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

  return (
    <div className="flex items-center gap-2 border-b border-border px-3 py-2">
      <Smartphone className="size-4 shrink-0 text-primary" />
      <span className="truncate font-medium">{displayName}</span>
      <span
        className={cn(
          'shrink-0 text-[11px]',
          !subtleStatus && 'rounded border px-1.5 py-0.5 text-[10px]',
          statusClassName
        )}
      >
        {statusLabel}
      </span>
      <div className="flex-1" />
      <Select
        value={selectedUdid ?? ''}
        onValueChange={onSelectDevice}
        disabled={loading || devices.length === 0}
      >
        <SelectTrigger className="h-7 w-[180px] text-xs">
          <SelectValue placeholder="Choose emulator" />
        </SelectTrigger>
        <SelectContent position="popper" side="bottom" align="start" sideOffset={4}>
          {devices.map((d) => (
            <SelectItem key={d.udid} value={d.udid} className="text-xs">
              {d.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="h-7 gap-1 px-2 text-xs"
            onClick={onRotate}
            disabled={!isLive || loading}
            aria-label="Rotate"
          >
            <RotateCw className="size-3.5" />
            <span className="hidden sm:inline">Rotate</span>
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={4}>
          Rotate
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="secondary"
            size="icon-xs"
            className="size-7"
            onClick={onHome}
            disabled={!isLive || loading}
            aria-label="Home"
          >
            <Home className="size-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={4}>
          Home
        </TooltipContent>
      </Tooltip>
      {isLive ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="icon-xs"
              className="size-7 text-muted-foreground hover:text-destructive"
              onClick={onShutdown}
              disabled={loading}
              aria-label="Shut down emulator"
            >
              <Power className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={4}>
            Shut down emulator
          </TooltipContent>
        </Tooltip>
      ) : (
        <Button
          type="button"
          size="sm"
          variant={loading ? 'ghost' : 'default'}
          className={cn('h-7 px-2 text-xs', loading && 'text-muted-foreground')}
          onClick={onAttach}
          disabled={loading || devices.length === 0}
        >
          {loading ? 'Working…' : 'Connect'}
        </Button>
      )}
    </div>
  )
}
