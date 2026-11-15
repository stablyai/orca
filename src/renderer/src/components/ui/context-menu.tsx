import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { ChevronRightIcon, CircleIcon } from 'lucide-react'
import * as ContextMenuPrimitive from 'radix-ui/context-menu'

import { cn } from '@/lib/class-names'
import { handleOverlayCloseAutoFocus } from '@/lib/overlay-interaction/overlay-focus-ownership'
import { OverlayFocusScope, useOverlayFocusScope } from './use-overlay-focus-scope'
import { handleImeOverlayEscape } from '@/lib/text-input/ime/ime-overlay-escape'
import { keepFocusWhileMenuCloses } from './menu-item-closing-focus'
import { useMenuPointerHighlight } from './menu-pointer-highlight'
import { MENU_SURFACE_CLASS } from './menu-surface'
import {
  MENU_ITEM_INDICATOR_CLASS,
  MENU_LABEL_CLASS,
  MENU_SHORTCUT_CLASS,
  MENU_SUB_TRIGGER_CHEVRON_CLASS,
  MenuDensityProvider,
  menuIndicatorItemVariants,
  menuItemVariants,
  menuSeparatorVariants,
  menuSubTriggerVariants,
  useMenuDensity,
  type MenuDensity
} from './menu-item'

function ContextMenu({ ...props }: React.ComponentProps<typeof ContextMenuPrimitive.Root>) {
  return <ContextMenuPrimitive.Root data-slot="context-menu" modal={false} {...props} />
}

function ContextMenuTrigger({
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Trigger>) {
  return <ContextMenuPrimitive.Trigger data-slot="context-menu-trigger" {...props} />
}

function ContextMenuSub({ ...props }: React.ComponentProps<typeof ContextMenuPrimitive.Sub>) {
  return <ContextMenuPrimitive.Sub data-slot="context-menu-sub" {...props} />
}

function ContextMenuRadioGroup({
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.RadioGroup>) {
  return <ContextMenuPrimitive.RadioGroup data-slot="context-menu-radio-group" {...props} />
}

function ContextMenuSubTrigger({
  className,
  inset,
  children,
  density,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.SubTrigger> & {
  inset?: boolean
  density?: MenuDensity
}) {
  const rowDensity = useMenuDensity(density)
  return (
    <ContextMenuPrimitive.SubTrigger
      data-slot="context-menu-sub-trigger"
      data-inset={inset}
      className={cn(menuSubTriggerVariants({ density: rowDensity, menu: 'context' }), className)}
      {...props}
    >
      {children}
      <ChevronRightIcon className={MENU_SUB_TRIGGER_CHEVRON_CLASS} />
    </ContextMenuPrimitive.SubTrigger>
  )
}

const contentAnimationVariants = cva('', {
  variants: {
    animation: {
      default:
        'data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:duration-150 data-[state=open]:zoom-in-[0.98]',
      none: 'data-[state=closed]:pointer-events-none'
    }
  },
  defaultVariants: { animation: 'default' }
})

function ContextMenuSubContent({
  className,
  animation,
  style,
  alignOffset = -5,
  density,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.SubContent> &
  VariantProps<typeof contentAnimationVariants> & {
    /** Defaults to the parent menu's density. */
    density?: MenuDensity
  }) {
  const pointerHighlight = useMenuPointerHighlight(props)
  const { ref: focusScopeRef, scope } = useOverlayFocusScope(pointerHighlight.ref)
  const subDensity = useMenuDensity(density)
  return (
    <ContextMenuPrimitive.Portal>
      <OverlayFocusScope value={scope}>
        <MenuDensityProvider value={subDensity}>
          <ContextMenuPrimitive.SubContent
            data-slot="context-menu-sub-content"
            // Level the first submenu row with its trigger (border + padding).
            alignOffset={alignOffset}
            className={cn(
              'z-[70] min-w-[11rem] origin-(--radix-context-menu-content-transform-origin) overflow-hidden',
              MENU_SURFACE_CLASS,
              contentAnimationVariants({ animation }),
              className
            )}
            // Portal submenus outside the scrollable parent to prevent overflow clipping.
            style={{ ...style, WebkitAppRegion: 'no-drag' } as React.CSSProperties}
            {...props}
            {...pointerHighlight}
            ref={focusScopeRef}
            onEscapeKeyDown={(event) => handleImeOverlayEscape(event, props.onEscapeKeyDown)}
          />
        </MenuDensityProvider>
      </OverlayFocusScope>
    </ContextMenuPrimitive.Portal>
  )
}

function ContextMenuContent({
  className,
  animation,
  style,
  density = 'default',
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Content> &
  VariantProps<typeof contentAnimationVariants> & {
    /** Row density for every row in this menu; a row's own `density` overrides it. */
    density?: MenuDensity
  }) {
  const pointerHighlight = useMenuPointerHighlight(props)
  const { ref: focusScopeRef, scope } = useOverlayFocusScope(pointerHighlight.ref)
  return (
    <ContextMenuPrimitive.Portal>
      <OverlayFocusScope value={scope}>
        <MenuDensityProvider value={density}>
          <ContextMenuPrimitive.Content
            data-slot="context-menu-content"
            className={cn(
              'z-[70] max-h-(--radix-context-menu-content-available-height) min-w-[11rem] origin-(--radix-context-menu-content-transform-origin) overflow-x-hidden overflow-y-auto scrollbar-sleek',
              MENU_SURFACE_CLASS,
              contentAnimationVariants({ animation }),
              className
            )}
            // Disable native dragging so overlapping titlebar regions cannot intercept menu clicks.
            style={{ ...style, WebkitAppRegion: 'no-drag' } as React.CSSProperties}
            {...props}
            onCloseAutoFocus={(event) => handleOverlayCloseAutoFocus(event, props.onCloseAutoFocus)}
            {...pointerHighlight}
            ref={focusScopeRef}
            onEscapeKeyDown={(event) => handleImeOverlayEscape(event, props.onEscapeKeyDown)}
          />
        </MenuDensityProvider>
      </OverlayFocusScope>
    </ContextMenuPrimitive.Portal>
  )
}

function ContextMenuItem({
  className,
  inset,
  variant = 'default',
  density,
  onPointerMove,
  onPointerLeave,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Item> & {
  inset?: boolean
  variant?: 'default' | 'destructive'
  density?: MenuDensity
}) {
  const rowDensity = useMenuDensity(density)
  return (
    <ContextMenuPrimitive.Item
      data-slot="context-menu-item"
      data-inset={inset}
      data-variant={variant}
      className={cn(menuItemVariants({ density: rowDensity, menu: 'context' }), className)}
      onPointerMove={keepFocusWhileMenuCloses(onPointerMove)}
      onPointerLeave={keepFocusWhileMenuCloses(onPointerLeave)}
      {...props}
    />
  )
}

function ContextMenuRadioItem({
  className,
  children,
  density,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.RadioItem> & {
  density?: MenuDensity
}) {
  const rowDensity = useMenuDensity(density)
  return (
    <ContextMenuPrimitive.RadioItem
      data-slot="context-menu-radio-item"
      className={cn(menuIndicatorItemVariants({ density: rowDensity }), className)}
      {...props}
    >
      <span className={MENU_ITEM_INDICATOR_CLASS}>
        <ContextMenuPrimitive.ItemIndicator>
          <CircleIcon className="size-2 fill-current" />
        </ContextMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </ContextMenuPrimitive.RadioItem>
  )
}

function ContextMenuLabel({
  className,
  inset,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Label> & {
  inset?: boolean
}) {
  return (
    <ContextMenuPrimitive.Label
      data-slot="context-menu-label"
      data-inset={inset}
      className={cn(MENU_LABEL_CLASS, className)}
      {...props}
    />
  )
}

function ContextMenuSeparator({
  className,
  density,
  ...props
}: React.ComponentProps<typeof ContextMenuPrimitive.Separator> & {
  density?: MenuDensity
}) {
  const rowDensity = useMenuDensity(density)
  return (
    <ContextMenuPrimitive.Separator
      data-slot="context-menu-separator"
      className={cn(menuSeparatorVariants({ density: rowDensity }), className)}
      {...props}
    />
  )
}

function ContextMenuShortcut({ className, ...props }: React.ComponentProps<'span'>) {
  return (
    <span
      data-slot="context-menu-shortcut"
      className={cn(MENU_SHORTCUT_CLASS, className)}
      {...props}
    />
  )
}

export {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuRadioItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuRadioGroup
}
