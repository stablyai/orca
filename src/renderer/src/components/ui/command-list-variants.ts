import { cva } from 'class-variance-authority'
import { menuSeparatorVariants } from './menu-item'

export const commandGroupVariants = cva(
  'overflow-hidden text-foreground [&_[cmdk-group-heading]]:text-muted-foreground',
  {
    variants: {
      variant: {
        default:
          'p-1 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium',
        menu: 'p-0 [&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pt-[5px] [&_[cmdk-group-heading]]:pb-[3px] [&_[cmdk-group-heading]]:text-2xs [&_[cmdk-group-heading]]:font-semibold'
      }
    },
    defaultVariants: { variant: 'default' }
  }
)

export const COMMAND_ITEM_BASE_CLASS =
  'relative flex cursor-default gap-2 select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*="size-"])]:size-4'

export const commandItemVariants = cva('', {
  variants: {
    selection: {
      default: '',
      palette: 'jump-palette-item',
      menu: 'data-[selected=true]:bg-black/8 data-[selected=true]:text-popover-foreground dark:data-[selected=true]:bg-white/14'
    },
    density: {
      default: '',
      workspace: 'px-3 py-2 text-xs',
      flush: 'p-0',
      menu: 'rounded-md px-2.5 py-[5px] text-[13px] leading-4'
    },
    // Cmd+J's workspace row box: titles share one column across row kinds.
    shape: {
      default: '',
      'palette-row':
        'group mx-0.5 flex cursor-pointer items-center gap-3 rounded-lg border border-transparent px-3 py-2.5 text-left transition-[background-color,border-color,box-shadow] data-[selected=true]:border-border data-[selected=true]:bg-accent data-[selected=true]:text-foreground'
    },
    emphasis: { default: '', pinned: 'bg-muted/35' }
  },
  defaultVariants: { selection: 'default' }
})

export const commandSeparatorVariants = cva('', {
  variants: {
    variant: { default: '-mx-1 h-px bg-border', menu: menuSeparatorVariants() }
  },
  defaultVariants: { variant: 'default' }
})
