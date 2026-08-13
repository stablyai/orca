import { Ellipsis } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import type { EmulatorBiometricAction } from './emulator-pane-types'

type EmulatorDeviceActionsMenuProps = {
  disabled: boolean
  onButton: (name: string) => void
  onBiometric: (action: EmulatorBiometricAction) => void
}

export function EmulatorDeviceActionsMenu({
  disabled,
  onButton,
  onBiometric
}: EmulatorDeviceActionsMenuProps) {
  const label = translate(
    'auto.components.emulator.pane.emulator.device.actions.menu.fa29179c0f',
    'More device actions'
  )

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="secondary"
              size="icon-xs"
              className="size-7"
              disabled={disabled}
              aria-label={label}
            >
              <Ellipsis className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={4}>
          {label}
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" className="min-w-[12rem]">
        <DropdownMenuLabel>
          {translate(
            'auto.components.emulator.pane.emulator.device.actions.menu.ec6370bcc7',
            'Hardware'
          )}
        </DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => onButton('side_button')}>
          {translate(
            'auto.components.emulator.pane.emulator.device.actions.menu.9ec74b4d24',
            'Side Button'
          )}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onButton('siri')}>
          {translate(
            'auto.components.emulator.pane.emulator.device.actions.menu.075f41864d',
            'Siri'
          )}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onButton('app_switcher')}>
          {translate(
            'auto.components.emulator.pane.emulator.device.actions.menu.4e5664df54',
            'App Switcher'
          )}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>
          {translate(
            'auto.components.emulator.pane.emulator.device.actions.menu.c354ee38ec',
            'Face ID'
          )}
        </DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => onBiometric('enroll')}>
          {translate(
            'auto.components.emulator.pane.emulator.device.actions.menu.109869fe69',
            'Enrolled'
          )}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onBiometric('unenroll')}>
          {translate(
            'auto.components.emulator.pane.emulator.device.actions.menu.8f274ef31a',
            'Not Enrolled'
          )}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onBiometric('match')}>
          {translate(
            'auto.components.emulator.pane.emulator.device.actions.menu.640607156a',
            'Matching Face'
          )}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onBiometric('nomatch')}>
          {translate(
            'auto.components.emulator.pane.emulator.device.actions.menu.0886900498',
            'Non-matching Face'
          )}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
