import * as React from 'react'
import { cva } from 'class-variance-authority'
import { CheckIcon, ChevronRightIcon, CircleIcon } from 'lucide-react'
import * as DropdownMenuPrimitive from 'radix-ui/dropdown-menu'
import { useControllableState } from 'radix-ui/internal'

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
import { PortalContainerContext, usePortalContainer } from './portal-container-context'

const DropdownMenuCloseContext = React.createContext<() => void>(() => {})

function useDropdownMenuClose() {
  return React.useContext(DropdownMenuCloseContext)
}

function DropdownMenu({
  open: controlledOpen,
  defaultOpen,
  onOpenChange,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Root>) {
  const [open, setOpen] = useControllableState({
    prop: controlledOpen,
    defaultProp: defaultOpen ?? false,
    onChange: onOpenChange,
    caller: 'DropdownMenu'
  })
  const close = React.useCallback(() => setOpen(false), [setOpen])
  return (
    <DropdownMenuCloseContext value={close}>
      <DropdownMenuPrimitive.Root
        data-slot="dropdown-menu"
        {...props}
        open={open}
        onOpenChange={setOpen}
      />
    </DropdownMenuCloseContext>
  )
}

function DropdownMenuPortal({
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Portal>) {
  return <DropdownMenuPrimitive.Portal data-slot="dropdown-menu-portal" {...props} />
}

function DropdownMenuTrigger({
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Trigger>) {
  return <DropdownMenuPrimitive.Trigger data-slot="dropdown-menu-trigger" {...props} />
}

function DropdownMenuContent({
  className,
  sideOffset = 4,
  portalContainer,
  style,
  density = 'default',
  variant = 'default',
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Content> & {
  portalContainer?: HTMLElement | null
  /** Row density for every row in this menu; a row's own `density` overrides it. */
  density?: MenuDensity
  /** `picker`: flush content whose own rows run edge to edge. */
  variant?: 'default' | 'picker'
  // Radix consumes this at its opening focus scope but omits it from the public Menu props.
  onOpenAutoFocus?: (event: Event) => void
}) {
  const container = usePortalContainer(portalContainer)
  const pointerHighlight = useMenuPointerHighlight(props)
  const { ref: focusScopeRef, scope } = useOverlayFocusScope(pointerHighlight.ref)
  return (
    <PortalContainerContext value={container}>
      <DropdownMenuPrimitive.Portal container={container ?? undefined}>
        <OverlayFocusScope value={scope}>
          <MenuDensityProvider value={density}>
            <DropdownMenuPrimitive.Content
              data-slot="dropdown-menu-content"
              sideOffset={sideOffset}
              className={cn(
                'z-[70] max-h-(--radix-dropdown-menu-content-available-height) min-w-[11rem] origin-(--radix-dropdown-menu-content-transform-origin) overflow-x-hidden overflow-y-auto scrollbar-sleek',
                MENU_SURFACE_CLASS,
                dropdownMenuContentVariants({ density, variant }),
                'data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in motion-reduce:data-[state=open]:animate-none motion-reduce:data-[state=closed]:animate-none data-[state=open]:fade-in-0 data-[state=open]:duration-150 data-[state=open]:zoom-in-[0.98]',
                className
              )}
              // Disable native dragging: titlebar drag regions intercept menu clicks regardless of z-index.
              style={{ ...style, WebkitAppRegion: 'no-drag' } as React.CSSProperties}
              {...props}
              onCloseAutoFocus={(event) =>
                handleOverlayCloseAutoFocus(event, props.onCloseAutoFocus)
              }
              {...pointerHighlight}
              ref={focusScopeRef}
              onEscapeKeyDown={(event) => handleImeOverlayEscape(event, props.onEscapeKeyDown)}
            />
          </MenuDensityProvider>
        </OverlayFocusScope>
      </DropdownMenuPrimitive.Portal>
    </PortalContainerContext>
  )
}

function DropdownMenuItem({
  className,
  inset,
  variant = 'default',
  density,
  onPointerMove,
  onPointerLeave,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Item> & {
  inset?: boolean
  /** `launch`: rows in the shared agent menu; at least 36px tall in either density.
   *  `sortable`: compact drag-handle rows that lift while `data-dragging` is set.
   *  `account-row` / `account-row-action`: an account row and its inline action; the row's wrapper draws one fill for both. */
  variant?:
    | 'default'
    | 'destructive'
    | 'launch'
    | 'sortable'
    | 'create'
    | 'account-row'
    | 'account-row-action'
  density?: MenuDensity
}) {
  const rowDensity = useMenuDensity(density)
  return (
    <DropdownMenuPrimitive.Item
      data-slot="dropdown-menu-item"
      data-inset={inset}
      data-variant={variant}
      className={cn(
        menuItemVariants({ density: rowDensity, menu: 'dropdown' }),
        'data-[variant=create]:rounded-[7px] data-[variant=create]:px-2 data-[variant=create]:py-1.5 data-[variant=create]:text-[12px] data-[variant=create]:leading-5 data-[variant=create]:font-medium',
        'data-[variant=account-row]:min-h-9 data-[variant=account-row]:rounded-[8px] data-[variant=account-row]:focus:bg-transparent data-[variant=account-row]:data-[current=true]:bg-transparent dark:data-[variant=account-row]:focus:bg-transparent',
        'data-[variant=account-row-action]:gap-1 data-[variant=account-row-action]:px-2.5 data-[variant=account-row-action]:text-xs data-[variant=account-row-action]:font-medium data-[variant=account-row-action]:focus:bg-transparent dark:data-[variant=account-row-action]:focus:bg-transparent',
        className
      )}
      onPointerMove={keepFocusWhileMenuCloses(onPointerMove)}
      onPointerLeave={keepFocusWhileMenuCloses(onPointerLeave)}
      {...props}
    />
  )
}

function DropdownMenuCheckboxItem({
  className,
  children,
  checked,
  density,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.CheckboxItem> & {
  density?: MenuDensity
}) {
  const rowDensity = useMenuDensity(density)
  return (
    <DropdownMenuPrimitive.CheckboxItem
      data-slot="dropdown-menu-checkbox-item"
      className={cn(menuIndicatorItemVariants({ density: rowDensity }), className)}
      checked={checked}
      {...props}
    >
      <span className={MENU_ITEM_INDICATOR_CLASS}>
        <DropdownMenuPrimitive.ItemIndicator>
          <CheckIcon className="size-3.5" />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </DropdownMenuPrimitive.CheckboxItem>
  )
}

function DropdownMenuRadioGroup({
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.RadioGroup>) {
  return <DropdownMenuPrimitive.RadioGroup data-slot="dropdown-menu-radio-group" {...props} />
}

function DropdownMenuRadioItem({
  className,
  children,
  density,
  indicator = 'dot',
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.RadioItem> & {
  density?: MenuDensity
  indicator?: 'dot' | 'check'
}) {
  const rowDensity = useMenuDensity(density)
  return (
    <DropdownMenuPrimitive.RadioItem
      data-slot="dropdown-menu-radio-item"
      className={cn(menuIndicatorItemVariants({ density: rowDensity }), className)}
      {...props}
    >
      <span className={MENU_ITEM_INDICATOR_CLASS}>
        <DropdownMenuPrimitive.ItemIndicator>
          {indicator === 'check' ? (
            <CheckIcon className="size-3.5" />
          ) : (
            <CircleIcon className="size-2 fill-current" />
          )}
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </DropdownMenuPrimitive.RadioItem>
  )
}

function DropdownMenuLabel({
  className,
  inset,
  variant,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Label> & {
  inset?: boolean
  variant?: 'title'
}) {
  return (
    <DropdownMenuPrimitive.Label
      data-slot="dropdown-menu-label"
      data-inset={inset}
      className={cn(
        MENU_LABEL_CLASS,
        variant === 'title' && 'pb-0 text-sm text-foreground',
        className
      )}
      {...props}
    />
  )
}

function DropdownMenuSeparator({
  className,
  density,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Separator> & {
  density?: MenuDensity
}) {
  const rowDensity = useMenuDensity(density)
  return (
    <DropdownMenuPrimitive.Separator
      data-slot="dropdown-menu-separator"
      className={cn(menuSeparatorVariants({ density: rowDensity }), className)}
      {...props}
    />
  )
}

function DropdownMenuShortcut({ className, ...props }: React.ComponentProps<'span'>) {
  return (
    <span
      data-slot="dropdown-menu-shortcut"
      className={cn(MENU_SHORTCUT_CLASS, className)}
      {...props}
    />
  )
}

function DropdownMenuSub({ ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Sub>) {
  return <DropdownMenuPrimitive.Sub data-slot="dropdown-menu-sub" {...props} />
}

function DropdownMenuSubTrigger({
  className,
  inset,
  children,
  hideChevron,
  variant = 'default',
  density,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.SubTrigger> & {
  inset?: boolean
  density?: MenuDensity
  // Why: collision-flipped submenus open leftward, where a right-pointing chevron misleads.
  hideChevron?: boolean
  variant?: 'default' | 'launch-row' | 'header-chip' | 'icon-row'
}) {
  const rowDensity = useMenuDensity(density)
  return (
    <DropdownMenuPrimitive.SubTrigger
      data-slot="dropdown-menu-sub-trigger"
      data-variant={variant}
      data-inset={inset}
      className={cn(
        menuSubTriggerVariants({
          density: rowDensity,
          variant,
          menu: 'dropdown'
        }),
        className
      )}
      {...props}
    >
      {hideChevron ? (
        children
      ) : (
        <>
          {children}
          <ChevronRightIcon className={MENU_SUB_TRIGGER_CHEVRON_CLASS} />
        </>
      )}
    </DropdownMenuPrimitive.SubTrigger>
  )
}

const dropdownMenuContentVariants = cva('', {
  variants: {
    density: { default: '', compact: '', comfortable: 'p-2' },
    variant: { default: '', picker: 'p-0' }
  },
  defaultVariants: { density: 'default', variant: 'default' }
})

function DropdownMenuSubContent({
  className,
  portalContainer,
  style,
  alignOffset,
  scrollable = false,
  variant = 'default',
  density,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.SubContent> & {
  portalContainer?: HTMLElement | null
  /** Defaults to the parent menu's density. */
  density?: MenuDensity
  scrollable?: boolean
  variant?: 'default' | 'picker'
}) {
  const container = usePortalContainer(portalContainer)
  const pointerHighlight = useMenuPointerHighlight(props)
  const { ref: focusScopeRef, scope } = useOverlayFocusScope(pointerHighlight.ref)
  const subDensity = useMenuDensity(density)
  const resolvedAlignOffset = alignOffset ?? (subDensity === 'comfortable' ? -9 : -5)
  return (
    <PortalContainerContext value={container}>
      <DropdownMenuPrimitive.Portal container={container ?? undefined}>
        <OverlayFocusScope value={scope}>
          <MenuDensityProvider value={subDensity}>
            <DropdownMenuPrimitive.SubContent
              data-slot="dropdown-menu-sub-content"
              data-variant={variant}
              // Level the first submenu row with its trigger (border + padding).
              alignOffset={resolvedAlignOffset}
              className={cn(
                'z-[70] min-w-[11rem] origin-(--radix-dropdown-menu-content-transform-origin) overflow-hidden',
                MENU_SURFACE_CLASS,
                'data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in motion-reduce:data-[state=open]:animate-none motion-reduce:data-[state=closed]:animate-none data-[state=open]:fade-in-0 data-[state=open]:duration-150 data-[state=open]:zoom-in-[0.98]',
                dropdownMenuContentVariants({ density: subDensity, variant }),
                scrollable &&
                  'max-h-(--radix-dropdown-menu-content-available-height) overflow-x-hidden overflow-y-auto scrollbar-sleek',
                className
              )}
              // Disable native dragging where submenu content overlaps the titlebar.
              style={{ ...style, WebkitAppRegion: 'no-drag' } as React.CSSProperties}
              {...props}
              {...pointerHighlight}
              ref={focusScopeRef}
              onEscapeKeyDown={(event) => handleImeOverlayEscape(event, props.onEscapeKeyDown)}
            />
          </MenuDensityProvider>
        </OverlayFocusScope>
      </DropdownMenuPrimitive.Portal>
    </PortalContainerContext>
  )
}

export {
  DropdownMenu,
  useDropdownMenuClose,
  DropdownMenuPortal,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent
}
