import React from 'react'
import { Columns2, Rows2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'
import type { PanelSplitChoice, PanelSplitMenuItem } from '@/lib/panel-split-candidates'

/** Split right / down controls that open a candidate picker instead of
 *  silently cloning the current tile (herdr-style intent: choose what spawns). */
export function PanelSplitMenuButtons({
  items,
  disabled,
  onPick,
  buttonClassName = 'size-5',
  iconClassName = 'size-3'
}: {
  items: readonly PanelSplitMenuItem[]
  disabled: boolean
  onPick: (direction: 'row' | 'column', choice: PanelSplitChoice) => void
  buttonClassName?: string
  iconClassName?: string
}): React.JSX.Element {
  return (
    <>
      <SplitDirectionMenu
        direction="row"
        items={items}
        disabled={disabled}
        onPick={onPick}
        buttonClassName={buttonClassName}
        iconClassName={iconClassName}
        ariaLabel={translate(
          'auto.components.panel-canvas.PanelCanvasPage.splitRight',
          'Split right'
        )}
        Icon={Columns2}
      />
      <SplitDirectionMenu
        direction="column"
        items={items}
        disabled={disabled}
        onPick={onPick}
        buttonClassName={buttonClassName}
        iconClassName={iconClassName}
        ariaLabel={translate(
          'auto.components.panel-canvas.PanelCanvasPage.splitDown',
          'Split down'
        )}
        Icon={Rows2}
      />
    </>
  )
}

function SplitDirectionMenu({
  direction,
  items,
  disabled,
  onPick,
  buttonClassName,
  iconClassName,
  ariaLabel,
  Icon
}: {
  direction: 'row' | 'column'
  items: readonly PanelSplitMenuItem[]
  disabled: boolean
  onPick: (direction: 'row' | 'column', choice: PanelSplitChoice) => void
  buttonClassName: string
  iconClassName: string
  ariaLabel: string
  Icon: typeof Columns2
}): React.JSX.Element {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className={buttonClassName}
          disabled={disabled || items.length === 0}
          aria-label={ariaLabel}
        >
          <Icon className={iconClassName} strokeWidth={1.75} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[14rem]">
        <DropdownMenuLabel className="text-[11px] font-normal text-muted-foreground">
          {translate(
            'auto.components.panel-canvas.PanelSplitMenu.chooseTile',
            'Choose tile to open'
          )}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {items.map((item) => (
          <DropdownMenuItem
            key={item.id}
            onSelect={() => onPick(direction, item.choice)}
            className="flex flex-col items-start gap-0.5"
          >
            <span className="text-[13px]">{item.label}</span>
            {item.subtitle ? (
              <span className="max-w-[16rem] truncate font-mono text-[10px] text-muted-foreground">
                {item.subtitle}
              </span>
            ) : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** Nested submenu items for context menus (sidebar Add to canvas). */
export function PanelSplitMenuItems({
  items,
  onPick
}: {
  items: readonly PanelSplitMenuItem[]
  onPick: (choice: PanelSplitChoice) => void
}): React.JSX.Element {
  return (
    <>
      {items.map((item) => (
        <DropdownMenuItem
          key={item.id}
          onSelect={() => onPick(item.choice)}
          className="flex flex-col items-start gap-0.5"
        >
          <span className="text-[13px]">{item.label}</span>
          {item.subtitle ? (
            <span className="max-w-[16rem] truncate font-mono text-[10px] text-muted-foreground">
              {item.subtitle}
            </span>
          ) : null}
        </DropdownMenuItem>
      ))}
    </>
  )
}
