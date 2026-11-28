import * as React from 'react'
import { cva } from 'class-variance-authority'

/**
 * Row styles shared by dropdown-menu.tsx and context-menu.tsx, in the spirit of menu-surface.ts.
 * `default` density is the 26px row (5 + 16 + 5); `compact` is the older 24px row for menus
 * that need to fit more rows; `comfortable` is the 30px row with 8px side/menu padding.
 */
export type MenuDensity = 'default' | 'compact' | 'comfortable'

const MenuDensityContext = React.createContext<MenuDensity>('default')

export const MenuDensityProvider = MenuDensityContext

/** A row's own density wins; otherwise it follows the nearest menu content. */
export function useMenuDensity(density: MenuDensity | undefined): MenuDensity {
  const inherited = React.useContext(MenuDensityContext)
  return density ?? inherited
}

const ROW_DENSITY = {
  default: 'px-2.5 py-[5px]',
  compact: 'px-2.5 py-1',
  comfortable: 'h-[30px] px-2 py-0'
} as const

const INDICATOR_ROW_DENSITY = {
  default: 'pr-2.5 pl-8 py-[5px]',
  compact: 'pr-2.5 pl-8 py-1',
  comfortable: 'h-[30px] pr-2 pl-8 py-0'
} as const

const ROW_BASE =
  'flex cursor-default items-center gap-2 rounded-md text-[13px] leading-4 font-normal outline-hidden select-none [&_svg]:pointer-events-none [&_svg]:shrink-0'
const ROW_FOCUS = 'focus:bg-black/8 dark:focus:bg-white/14'
const ROW_DISABLED = 'data-[disabled]:pointer-events-none data-[disabled]:opacity-40'
const ROW_ICON =
  "[&_svg:not([class*='size-'])]:size-[15px] [&_svg:not([class*='text-'])]:text-muted-foreground [&_svg]:stroke-[1.5]"

export const menuItemVariants = cva(
  [
    'relative',
    ROW_BASE,
    ROW_FOCUS,
    ROW_DISABLED,
    'data-[inset]:pl-8',
    'data-[variant=destructive]:text-[color-mix(in_srgb,var(--destructive)_78%,black)] dark:data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-destructive/10 dark:data-[variant=destructive]:focus:bg-destructive/20',
    ROW_ICON,
    'data-[variant=destructive]:*:[svg]:text-current!'
  ],
  {
    variants: {
      density: ROW_DENSITY,
      menu: {
        // Dropdown rows carry the extra states its consumers set: search default, nested context
        // menu, aria-disabled, current, and the shared agent menu's 36px `launch` row.
        dropdown:
          'data-[search-default]:bg-black/8 dark:data-[search-default]:bg-white/14 data-[context-menu-open]:bg-black/8 dark:data-[context-menu-open]:bg-white/14 aria-disabled:opacity-40 data-[current=true]:bg-accent data-[current=true]:data-[disabled]:opacity-100 data-[variant=launch]:min-h-9 data-[variant=launch]:rounded-[7px] data-[variant=launch]:px-2 data-[variant=launch]:py-1.5 data-[variant=launch]:text-[13px] data-[variant=launch]:leading-4 data-[variant=launch]:font-medium data-[variant=sortable]:gap-2 data-[variant=sortable]:py-[3px] data-[variant=sortable]:pr-1.5 data-[variant=sortable]:pl-1 data-[variant=sortable]:data-[dragging]:relative data-[variant=sortable]:data-[dragging]:z-10 data-[variant=sortable]:data-[dragging]:bg-popover data-[variant=sortable]:data-[dragging]:shadow-floating',
        context: ''
      }
    },
    defaultVariants: { density: 'default', menu: 'dropdown' }
  }
)

/** Checkbox and radio rows: inset to leave room for the indicator at the left edge. */
export const menuIndicatorItemVariants = cva(
  ['relative', ROW_BASE, ROW_FOCUS, ROW_DISABLED, "[&_svg:not([class*='size-'])]:size-3.5"],
  {
    variants: { density: INDICATOR_ROW_DENSITY },
    defaultVariants: { density: 'default' }
  }
)

export const MENU_ITEM_INDICATOR_CLASS =
  'pointer-events-none absolute left-2.5 flex size-3.5 items-center justify-center'

export const menuSubTriggerVariants = cva([ROW_BASE, 'data-[inset]:pl-8', ROW_ICON], {
  variants: {
    // Density precedes variant so the chip and launch rows' own padding wins the merge.
    density: ROW_DENSITY,
    variant: {
      default: `${ROW_FOCUS} data-[state=open]:bg-black/8 dark:data-[state=open]:bg-white/14`,
      'launch-row':
        'gap-0 rounded-[7px] p-0 text-xs leading-5 font-medium focus:bg-accent focus:text-accent-foreground focus-within:bg-accent focus-within:text-accent-foreground data-[search-default]:bg-accent data-[search-default]:text-accent-foreground has-[[data-context-menu-open]]:bg-accent has-[[data-context-menu-open]]:text-accent-foreground data-[state=open]:bg-accent data-[state=open]:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-40',
      // A row of icon buttons that opens its submenu on hover; the active icon carries the highlight.
      'icon-row': 'gap-0.5 rounded-[9px] p-0 outline-hidden',
      'header-chip':
        'h-[22px] max-w-[9.5rem] min-w-0 gap-1 rounded-md px-1.5 py-0 text-2xs font-medium text-muted-foreground hover:bg-black/8 hover:text-foreground focus:bg-black/8 focus:text-foreground data-[state=open]:bg-black/8 data-[state=open]:text-foreground dark:hover:bg-white/14 dark:focus:bg-white/14 dark:data-[state=open]:bg-white/14 data-[disabled]:pointer-events-none data-[disabled]:opacity-40'
    },
    menu: { dropdown: '', context: '' }
  },
  compoundVariants: [
    // Context submenu triggers have never dimmed when disabled; keep that until it is a decision.
    { menu: 'dropdown', variant: 'default', class: ROW_DISABLED }
  ],
  defaultVariants: {
    density: 'default',
    variant: 'default',
    menu: 'dropdown'
  }
})

export const MENU_LABEL_CLASS =
  'px-2.5 pt-[5px] pb-[3px] text-2xs font-semibold text-muted-foreground data-[inset]:pl-8'

export const menuSeparatorVariants = cva('h-px bg-black/7 dark:bg-white/10', {
  variants: {
    density: {
      default: '-mx-[6px] my-[6px]',
      compact: '-mx-[6px] my-[5px]',
      comfortable: '-mx-2 my-2'
    }
  },
  defaultVariants: { density: 'default' }
})

export const MENU_SHORTCUT_CLASS =
  'ml-auto shrink-0 whitespace-nowrap pl-4 tracking-normal text-muted-foreground'

export const MENU_SUB_TRIGGER_CHEVRON_CLASS = 'ml-auto size-3.5 text-current opacity-70'
