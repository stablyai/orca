import { FoldHorizontal, UnfoldHorizontal, Watch, ZoomIn } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import type { EmulatorZoomAction } from './emulator-pane-zoom'
import type { AndroidEmulatorToolbarControlsProps } from './android-emulator-toolbar-controls'

export const label = (text: string): string =>
  translate(`auto.components.emulator.pane.androidToolbar.${text}`, text)

type ControlButtonProps = {
  label: string
  disabled: boolean
  onClick: () => void
  onPointerDown?: () => void
  onPointerUp?: () => void
  onPointerCancel?: () => void
  onPointerLeave?: () => void
  children: React.ReactNode
}

export function ControlButton({
  label: text,
  disabled,
  onClick,
  onPointerDown,
  onPointerUp,
  onPointerCancel,
  onPointerLeave,
  children
}: ControlButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="secondary"
          size="icon-xs"
          className="size-7 shrink-0"
          aria-label={text}
          disabled={disabled}
          onClick={onClick}
          onPointerDown={onPointerDown}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
          onPointerLeave={onPointerLeave}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={4}>
        {text}
      </TooltipContent>
    </Tooltip>
  )
}

export function ZoomMenu({
  disabled,
  percentage,
  availability,
  onChange
}: {
  disabled: boolean
  percentage: number
  availability: Record<EmulatorZoomAction, boolean>
  onChange: (action: EmulatorZoomAction) => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="secondary"
          size="icon-xs"
          className="size-7 shrink-0"
          aria-label={label('Zoom')}
          disabled={disabled}
        >
          <ZoomIn className="size-3.5" />
          <span className="sr-only">{percentage}%</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <ZoomItems availability={availability} onChange={onChange} />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function ZoomItems({
  availability,
  onChange
}: {
  availability: Record<EmulatorZoomAction, boolean>
  onChange: (action: EmulatorZoomAction) => void
}) {
  const items: [EmulatorZoomAction, string][] = [
    ['in', 'Zoom In'],
    ['out', 'Zoom Out'],
    ['actual', 'Zoom to Actual Size (100%)'],
    ['fit', 'Zoom to Fit in Window'],
    ['fit-display', 'Zoom to Fit Display in Window']
  ]
  return items.map(([action, text]) => (
    <DropdownMenuItem
      key={action}
      disabled={!availability[action]}
      onSelect={(event) => {
        if (action === 'in' || action === 'out') {
          event.preventDefault()
        }
        onChange(action)
      }}
    >
      {label(text)}
    </DropdownMenuItem>
  ))
}

export function SpecificControls({
  capabilities,
  disabled,
  onButton,
  onPosture
}: Pick<AndroidEmulatorToolbarControlsProps, 'capabilities' | 'onButton' | 'onPosture'> & {
  disabled: boolean
}) {
  return (
    <>
      {capabilities?.foldable ? (
        <>
          <ControlButton
            label={label('Fold')}
            disabled={disabled}
            onClick={() => onPosture('folded')}
          >
            <FoldHorizontal className="size-3.5" />
          </ControlButton>
          <ControlButton
            label={label('Unfold')}
            disabled={disabled}
            onClick={() => onPosture('unfolded')}
          >
            <UnfoldHorizontal className="size-3.5" />
          </ControlButton>
        </>
      ) : null}
      {capabilities?.wearButton1 ? (
        <ControlButton
          label={label('Button 1')}
          disabled={disabled}
          onClick={() => onButton('wear_button_1')}
        >
          <Watch className="size-3.5" />
        </ControlButton>
      ) : null}
      {capabilities?.wearButton2 ? (
        <ControlButton
          label={label('Button 2')}
          disabled={disabled}
          onClick={() => onButton('wear_button_2')}
        >
          <Watch className="size-3.5" />
        </ControlButton>
      ) : null}
    </>
  )
}

export function SpecificMenuItems({
  capabilities,
  disabled,
  onButton,
  onPosture
}: Pick<AndroidEmulatorToolbarControlsProps, 'capabilities' | 'onButton' | 'onPosture'> & {
  disabled: boolean
}) {
  return (
    <>
      {capabilities?.foldable ? (
        <>
          <MenuItem label={label('Fold')} onSelect={() => onPosture('folded')} disabled={disabled}>
            <FoldHorizontal className="size-3.5" />
          </MenuItem>
          <MenuItem
            label={label('Unfold')}
            onSelect={() => onPosture('unfolded')}
            disabled={disabled}
          >
            <UnfoldHorizontal className="size-3.5" />
          </MenuItem>
        </>
      ) : null}
      {capabilities?.wearButton1 ? (
        <MenuItem
          label={label('Button 1')}
          onSelect={() => onButton('wear_button_1')}
          disabled={disabled}
        >
          <Watch className="size-3.5" />
        </MenuItem>
      ) : null}
      {capabilities?.wearButton2 ? (
        <MenuItem
          label={label('Button 2')}
          onSelect={() => onButton('wear_button_2')}
          disabled={disabled}
        >
          <Watch className="size-3.5" />
        </MenuItem>
      ) : null}
    </>
  )
}

export function MenuItem({
  label: text,
  disabled,
  onSelect,
  onPointerDown,
  onPointerUp,
  onPointerCancel,
  onPointerLeave,
  children
}: {
  label: string
  disabled: boolean
  onSelect: (event: Event) => void
  onPointerDown?: () => void
  onPointerUp?: () => void
  onPointerCancel?: () => void
  onPointerLeave?: () => void
  children: React.ReactNode
}) {
  return (
    <DropdownMenuItem
      disabled={disabled}
      onSelect={onSelect}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onPointerLeave={onPointerLeave}
    >
      {children}
      {text}
    </DropdownMenuItem>
  )
}

export function keepMenuOpen(event: Event, action: () => void): void {
  event.preventDefault()
  action()
}
