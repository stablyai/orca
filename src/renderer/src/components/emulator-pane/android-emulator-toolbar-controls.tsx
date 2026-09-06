import { useEffect, useRef } from 'react'
import {
  ArrowLeft,
  Camera,
  Home,
  MoreHorizontal,
  Power,
  RotateCcw,
  RotateCw,
  SquareStack,
  Volume1,
  Volume2,
  ZoomIn
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import type {
  EmulatorButtonOptions,
  EmulatorDeviceControlCapabilities,
  EmulatorPosture
} from '../../../../shared/emulator-device-controls'
import type { EmulatorZoomAction } from './emulator-pane-zoom'
import {
  ControlButton,
  label,
  MenuItem,
  SpecificControls,
  SpecificMenuItems,
  ZoomItems,
  ZoomMenu,
  keepMenuOpen
} from './android-emulator-toolbar-action-components'

export type AndroidEmulatorToolbarControlsProps = {
  capabilities?: EmulatorDeviceControlCapabilities
  disabled: boolean
  displayCommandPending: boolean
  screenshotAvailable: boolean
  savingScreenshot: boolean
  zoomPercentage: number
  zoomAvailability: Record<EmulatorZoomAction, boolean>
  onButton: (
    name:
      | 'back'
      | 'home'
      | 'recents'
      | 'power'
      | 'volume_up'
      | 'volume_down'
      | 'wear_button_1'
      | 'wear_button_2',
    options?: EmulatorButtonOptions
  ) => void
  onPosture: (posture: EmulatorPosture) => void
  onRotate: (direction: 'left' | 'right') => void
  onScreenshot: () => void
  onZoomChange: (action: EmulatorZoomAction) => void
}

export const POWER_LONG_PRESS_MS = 500

export function AndroidEmulatorToolbarControls({
  capabilities,
  disabled,
  displayCommandPending,
  screenshotAvailable,
  savingScreenshot,
  zoomPercentage,
  zoomAvailability,
  onButton,
  onPosture,
  onRotate,
  onScreenshot,
  onZoomChange
}: AndroidEmulatorToolbarControlsProps) {
  const powerLongPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const powerLongPressTriggeredRef = useRef(false)
  const suppressPowerClickRef = useRef(false)
  const commonDisabled = disabled
  const specificEntriesVisible = Boolean(
    capabilities?.foldable || capabilities?.wearButton1 || capabilities?.wearButton2
  )
  const visible = {
    power: capabilities?.power !== false,
    volume: capabilities?.volume !== false,
    overview: capabilities?.overview !== false,
    foldable: capabilities?.foldable === true,
    wearButton1: capabilities?.wearButton1 === true,
    wearButton2: capabilities?.wearButton2 === true
  }

  const clearPowerTimer = (): void => {
    if (powerLongPressTimerRef.current !== null) {
      clearTimeout(powerLongPressTimerRef.current)
      powerLongPressTimerRef.current = null
    }
  }
  useEffect(
    () => () => {
      clearPowerTimer()
    },
    []
  )
  const handlePowerPointerDown = (): void => {
    powerLongPressTriggeredRef.current = false
    suppressPowerClickRef.current = false
    clearPowerTimer()
    powerLongPressTimerRef.current = setTimeout(() => {
      powerLongPressTriggeredRef.current = true
      onButton('power', { longPress: true })
    }, POWER_LONG_PRESS_MS)
  }
  const handlePowerPointerUp = (): void => {
    clearPowerTimer()
    if (!powerLongPressTriggeredRef.current) {
      onButton('power')
    }
    suppressPowerClickRef.current = true
  }
  const handlePowerPointerCancel = (): void => {
    clearPowerTimer()
    suppressPowerClickRef.current = true
  }
  const handlePowerPointerLeave = (): void => {
    clearPowerTimer()
  }
  const handlePowerClick = (): void => {
    if (suppressPowerClickRef.current) {
      suppressPowerClickRef.current = false
      return
    }
    onButton('power')
  }

  const power = visible.power ? (
    <ControlButton
      label={label('Power')}
      disabled={commonDisabled}
      onClick={handlePowerClick}
      onPointerDown={handlePowerPointerDown}
      onPointerUp={handlePowerPointerUp}
      onPointerCancel={handlePowerPointerCancel}
      onPointerLeave={handlePowerPointerLeave}
    >
      <Power className="size-3.5" />
    </ControlButton>
  ) : null
  const powerMenuItem = visible.power ? (
    <MenuItem
      label={label('Power')}
      disabled={commonDisabled}
      onSelect={() => handlePowerClick()}
      onPointerDown={handlePowerPointerDown}
      onPointerUp={handlePowerPointerUp}
      onPointerCancel={handlePowerPointerCancel}
      onPointerLeave={handlePowerPointerLeave}
    >
      <Power className="size-3.5" />
    </MenuItem>
  ) : null
  const volumeUp = visible.volume ? (
    <ControlButton
      label={label('Volume Up')}
      disabled={commonDisabled}
      onClick={() => onButton('volume_up')}
    >
      <Volume2 className="size-3.5" />
    </ControlButton>
  ) : null
  const volumeDown = visible.volume ? (
    <ControlButton
      label={label('Volume Down')}
      disabled={commonDisabled}
      onClick={() => onButton('volume_down')}
    >
      <Volume1 className="size-3.5" />
    </ControlButton>
  ) : null
  const rotateLeft = (
    <ControlButton
      label={label('Rotate Left')}
      disabled={commonDisabled || displayCommandPending}
      onClick={() => onRotate('left')}
    >
      <RotateCcw className="size-3.5" />
    </ControlButton>
  )
  const rotateRight = (
    <ControlButton
      label={label('Rotate Right')}
      disabled={commonDisabled || displayCommandPending}
      onClick={() => onRotate('right')}
    >
      <RotateCw className="size-3.5" />
    </ControlButton>
  )
  const screenshot = (
    <ControlButton
      label={label('Take Screenshot')}
      disabled={commonDisabled || !screenshotAvailable || savingScreenshot}
      onClick={onScreenshot}
    >
      <Camera className="size-3.5" />
    </ControlButton>
  )
  const zoom = (
    <ZoomMenu
      disabled={commonDisabled || !Object.values(zoomAvailability).some(Boolean)}
      percentage={zoomPercentage}
      availability={zoomAvailability}
      onChange={onZoomChange}
    />
  )
  const back = (
    <ControlButton label={label('Back')} disabled={commonDisabled} onClick={() => onButton('back')}>
      <ArrowLeft className="size-3.5" />
    </ControlButton>
  )
  const home = (
    <ControlButton label={label('Home')} disabled={commonDisabled} onClick={() => onButton('home')}>
      <Home className="size-3.5" />
    </ControlButton>
  )
  const overview = visible.overview ? (
    <ControlButton
      label={label('Overview')}
      disabled={commonDisabled}
      onClick={() => onButton('recents')}
    >
      <SquareStack className="size-3.5" />
    </ControlButton>
  ) : null

  return (
    <div className="contents">
      <div className="hidden shrink-0 items-center gap-1 [@container(min-width:960px)]:flex">
        {power}
        {volumeUp}
        {volumeDown}
        {rotateLeft}
        {rotateRight}
        {screenshot}
        {zoom}
        {back}
        {home}
        {overview}
        {specificEntriesVisible ? (
          <SpecificControls
            capabilities={capabilities}
            disabled={commonDisabled || displayCommandPending}
            onButton={onButton}
            onPosture={onPosture}
          />
        ) : null}
      </div>
      <div className="flex w-fit shrink-0 items-center gap-1 [@container(min-width:960px)]:hidden">
        {back}
        {home}
        {overview}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="secondary"
              size="icon-xs"
              className="size-7"
              disabled={commonDisabled}
              aria-label={label('More')}
            >
              <MoreHorizontal className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            {powerMenuItem}
            {visible.volume ? (
              <>
                <MenuItem
                  label={label('Volume Up')}
                  onSelect={(event) => keepMenuOpen(event, () => onButton('volume_up'))}
                  disabled={commonDisabled}
                >
                  <Volume2 className="size-3.5" />
                </MenuItem>
                <MenuItem
                  label={label('Volume Down')}
                  onSelect={(event) => keepMenuOpen(event, () => onButton('volume_down'))}
                  disabled={commonDisabled}
                >
                  <Volume1 className="size-3.5" />
                </MenuItem>
              </>
            ) : null}
            <MenuItem
              label={label('Rotate Left')}
              onSelect={(event) => keepMenuOpen(event, () => onRotate('left'))}
              disabled={commonDisabled || displayCommandPending}
            >
              <RotateCcw className="size-3.5" />
            </MenuItem>
            <MenuItem
              label={label('Rotate Right')}
              onSelect={(event) => keepMenuOpen(event, () => onRotate('right'))}
              disabled={commonDisabled || displayCommandPending}
            >
              <RotateCw className="size-3.5" />
            </MenuItem>
            <MenuItem
              label={label('Take Screenshot')}
              onSelect={() => onScreenshot()}
              disabled={commonDisabled || !screenshotAvailable || savingScreenshot}
            >
              <Camera className="size-3.5" />
            </MenuItem>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger
                disabled={commonDisabled || !Object.values(zoomAvailability).some(Boolean)}
              >
                <ZoomIn className="size-3.5" />
                {label('Zoom')}
                <span className="ml-auto text-muted-foreground">{zoomPercentage}%</span>
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <ZoomItems availability={zoomAvailability} onChange={onZoomChange} />
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <SpecificMenuItems
              capabilities={capabilities}
              disabled={commonDisabled || displayCommandPending}
              onButton={onButton}
              onPosture={onPosture}
            />
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  )
}
