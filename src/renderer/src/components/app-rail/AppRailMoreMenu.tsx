import React, { useLayoutEffect, useRef, useState } from 'react'
import { CircleHelp, Ellipsis, Settings } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import type { HelpMenuController } from '@/components/sidebar/chrome/help-menu-controller'
import { AppRailButton } from './AppRailButton'
import { appRailSlotCapacity } from './app-rail-overflow'

/** What doesn't fit on a very short rail: Help (as a submenu sharing the rail's one Help controller), then Settings. */
export function AppRailMoreMenu({
  help,
  includeHelp,
  includeSettings,
  settingsActive,
  onOpenSettings,
  tabStop
}: {
  help: HelpMenuController
  includeHelp: boolean
  includeSettings: boolean
  settingsActive: boolean
  onOpenSettings: () => void
  tabStop: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const label = t('appRail.more', 'More')
  const settingsLabel = t('auto.components.sidebar.SidebarSettingsHelpMenu.a428c25998', 'Settings')
  const current = includeSettings && settingsActive ? settingsLabel : undefined
  return (
    <DropdownMenu modal={false} onOpenChange={help.handleMenuOpenChange}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <AppRailButton
              itemId="more"
              label={current ? `${label}, ${current}` : label}
              active={current !== undefined}
              tabStop={tabStop}
              icon={<Ellipsis size={18} aria-hidden />}
            />
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="right" sideOffset={6}>
          {current ? `${label} · ${current}` : label}
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent side="right" align="start" sideOffset={8} className="w-52">
        {includeHelp ? (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <CircleHelp className="size-3.5" aria-hidden />
              {t('auto.components.sidebar.SidebarSettingsHelpMenu.2991a0106c', 'Help')}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-52">{help.items}</DropdownMenuSubContent>
          </DropdownMenuSub>
        ) : null}
        {includeSettings ? (
          <DropdownMenuItem
            onSelect={onOpenSettings}
            aria-current={settingsActive ? 'page' : undefined}
          >
            <Settings className="size-3.5" aria-hidden />
            {settingsLabel}
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * Whole slots that fit in the toolbar; state changes only when that number changes, not per pixel.
 * `onWillChange` runs just before a new count is committed, so callers can sample state tied to that transition.
 */
export function useAppRailSlotCapacity(
  toolbar: HTMLElement | null,
  onWillChange?: () => void
): number {
  const [capacity, setCapacity] = useState(Number.POSITIVE_INFINITY)
  const lastRef = useRef(Number.POSITIVE_INFINITY)
  const onWillChangeRef = useRef(onWillChange)
  useLayoutEffect(() => {
    onWillChangeRef.current = onWillChange
  })
  useLayoutEffect(() => {
    if (!toolbar) {
      return
    }
    let retired = false
    const measure = (): void => {
      if (retired) {
        return
      }
      // The toolbar has no border and is sized by the rail column (flex-1, min-h-0), never by its content.
      const style = getComputedStyle(toolbar)
      const padding =
        (Number.parseFloat(style.paddingTop) || 0) + (Number.parseFloat(style.paddingBottom) || 0)
      const next = appRailSlotCapacity(toolbar.getBoundingClientRect().height - padding)
      if (next === lastRef.current) {
        return
      }
      // The first measure isn't a transition: nothing was rendered under another partition yet.
      if (lastRef.current !== Number.POSITIVE_INFINITY) {
        onWillChangeRef.current?.()
      }
      lastRef.current = next
      setCapacity(next)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(toolbar)
    return () => {
      retired = true
      observer.disconnect()
    }
  }, [toolbar])
  return capacity
}
