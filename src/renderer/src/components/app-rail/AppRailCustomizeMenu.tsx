import React from 'react'
import { Check, Ellipsis } from 'lucide-react'
import { cn } from '@/lib/class-names'
import { useTranslate } from '@/i18n/use-translate'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { APP_RAIL_ICON_SIZE, APP_RAIL_ICON_STROKE_WIDTH, AppRailButton } from './AppRailButton'

export type AppRailCustomizeRow = {
  id: string
  label: string
  icon: React.ReactNode
  shown: boolean
  onToggle: () => void
}

export function useAppRailCustomizeLabel(): string {
  const t = useTranslate()
  return t('appRail.customize', 'Customize')
}

/** One checkbox row per rail page; toggling keeps the menu open so several can change in one visit. */
export function AppRailCustomizeRows({
  rows
}: {
  rows: readonly AppRailCustomizeRow[]
}): React.JSX.Element {
  return (
    <>
      {rows.map((row) => (
        <DropdownMenuItem
          key={row.id}
          role="menuitemcheckbox"
          aria-checked={row.shown}
          className="h-7 gap-2 px-2 py-0"
          onSelect={(event) => {
            event.preventDefault()
            row.onToggle()
          }}
        >
          {row.icon}
          <span className="min-w-0 flex-1 truncate">{row.label}</span>
          <Check
            className={cn('size-3.5 text-muted-foreground', !row.shown && 'invisible')}
            aria-hidden
          />
        </DropdownMenuItem>
      ))}
    </>
  )
}

/** The rail's "…": which pages the rail shows, in rail order. Becomes More's Customize submenu when the rail folds. */
export function AppRailCustomizeMenu({
  rows,
  tabStop
}: {
  rows: readonly AppRailCustomizeRow[]
  tabStop: boolean
}): React.JSX.Element {
  const label = useAppRailCustomizeLabel()
  return (
    <DropdownMenu modal={false}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <AppRailButton
              itemId="customize"
              label={label}
              tabStop={tabStop}
              icon={
                <Ellipsis
                  size={APP_RAIL_ICON_SIZE}
                  strokeWidth={APP_RAIL_ICON_STROKE_WIDTH}
                  aria-hidden
                />
              }
            />
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="right" sideOffset={6}>
          {label}
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent side="right" align="start" sideOffset={8} className="p-1">
        <AppRailCustomizeRows rows={rows} />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
