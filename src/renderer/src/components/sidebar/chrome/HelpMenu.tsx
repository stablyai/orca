import React, { useState } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import {
  useHelpMenuController,
  type HelpMenuController,
  type SetupMilestones
} from './help-menu-controller'

/** Help's dropdown around an existing controller; the controller's owner renders `controller.dialog` once. */
export function HelpMenuView({
  controller,
  trigger,
  side,
  align
}: {
  controller: HelpMenuController
  trigger: React.ReactElement
  side: 'top' | 'right'
  align: 'start' | 'end'
}): React.JSX.Element {
  const t = useTranslate()
  const [menuOpen, setMenuOpen] = useState(false)
  const handleOpenChange = (open: boolean): void => {
    controller.handleMenuOpenChange(open)
    setMenuOpen(open)
  }
  return (
    <DropdownMenu modal={false} open={menuOpen} onOpenChange={handleOpenChange}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side={side} sideOffset={side === 'top' ? 4 : 6}>
          {t('auto.components.sidebar.SidebarSettingsHelpMenu.2991a0106c', 'Help')}
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent side={side} align={align} sideOffset={8} className="w-52">
        {controller.items}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** Help dropdown with its own controller (the list toolbar's Help). */
export function HelpMenu({
  trigger,
  side,
  align,
  milestones
}: {
  trigger: React.ReactElement
  side: 'top' | 'right'
  align: 'start' | 'end'
  milestones: SetupMilestones | null
}): React.JSX.Element {
  const controller = useHelpMenuController(milestones)
  return (
    <>
      <HelpMenuView controller={controller} trigger={trigger} side={side} align={align} />
      {controller.dialog}
    </>
  )
}
