'use client'

import { SidebarZoomContext } from './sidebar-zoom-context'
import { SECURITY_SURFACE_CLASS } from './security-surface'
import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { Minus, XIcon } from 'lucide-react'
import * as DialogPrimitive from 'radix-ui/dialog'

import { usePortalContainer } from './portal-container-context'
import { cn } from '@/lib/class-names'
import { handleOverlayCloseAutoFocus } from '@/lib/overlay-interaction/overlay-focus-ownership'
import { OverlayFocusScope, useOverlayFocusScope } from './use-overlay-focus-scope'
import { handleImeOverlayEscape } from '@/lib/text-input/ime/ime-overlay-escape'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import {
  DialogLayoutContext,
  isUnifiedDialogSize,
  useDialogLayout,
  type DialogLayout,
  type UnifiedDialogSize
} from './dialog-layout-context'

function Dialog({ ...props }: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return (
    <SidebarZoomContext value={false}>
      <DialogPrimitive.Root data-slot="dialog" {...props} />
    </SidebarZoomContext>
  )
}

function DialogTrigger({ ...props }: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />
}

function DialogPortal({
  container,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  const inherited = usePortalContainer()
  const portalContainer = container === undefined ? (inherited ?? undefined) : container
  return <DialogPrimitive.Portal data-slot="dialog-portal" container={portalContainer} {...props} />
}

function DialogClose({ ...props }: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />
}

function DialogOverlay({
  className,
  scrim = 'default',
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay> & {
  /** `dark` hides the app behind full-window media. */
  scrim?: 'default' | 'dark'
}) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn(
        'fixed inset-0 z-50 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0',
        scrim === 'dark' ? 'bg-black/80' : 'bg-black/55',
        className
      )}
      {...props}
    />
  )
}

/** Media sits straight on the scrim; scaling in would make its edge controls slide. */
const MEDIA_SURFACE_CLASS =
  'inset-0 h-dvh w-screen max-w-none translate-x-0 translate-y-0 gap-0 overflow-hidden rounded-none border-0 bg-transparent p-0 shadow-none data-[state=closed]:[--tw-exit-scale:1]! data-[state=open]:[--tw-enter-scale:1]! sm:max-w-none dark:shadow-none'

const dialogContentVariants = cva('', {
  variants: {
    density: {
      default: '',
      compact: 'gap-3.5 p-4'
    },
    surface: {
      default: '',
      /** The tinted, edge-to-edge panel of the two-column feature tip dialogs. */
      'feature-tip':
        'gap-0 bg-[color-mix(in_srgb,var(--foreground)_8%,var(--background))] p-0 dark:bg-[color-mix(in_srgb,var(--foreground)_16%,var(--background))]',
      /** Edge to edge, for an embedded panel that brings its own header and padding. */
      panel: 'gap-0 p-0',
      /** `panel`, opaque: content scrolling under sticky headings (`bg-popover`) must not show through. */
      'opaque-panel': 'gap-0 bg-popover p-0',
      /** Trust, consent and provenance decisions: host-owned tokens a plugin theme cannot restyle. */
      security: SECURITY_SURFACE_CLASS,
      media: MEDIA_SURFACE_CLASS,
      /** `media` stepping through a set: focus can rest on the dialog, whose ring the content draws
       *  above the image (`group-focus-visible/media-gallery`), since a zoomed image covers its edges. */
      'media-gallery': `${MEDIA_SURFACE_CLASS} group/media-gallery`
    }
  },
  defaultVariants: { density: 'default', surface: 'default' }
})

function DialogContentCloseButton({ variant }: { variant: 'close' | 'minimize' }) {
  const t = useTranslate()
  const label =
    variant === 'minimize'
      ? t('auto.components.ui.dialog.minimize', 'Minimize')
      : t('auto.components.ui.dialog.f26c4baeda', 'Close')
  const button = (
    <DialogPrimitive.Close
      data-slot="dialog-close"
      className="absolute top-4 right-4 rounded-xs opacity-70 outline-none transition-opacity hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4"
    >
      {variant === 'minimize' ? <Minus className="size-3.5" /> : <XIcon />}
      <span className="sr-only">{label}</span>
    </DialogPrimitive.Close>
  )
  return variant === 'minimize' ? (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {label}
      </TooltipContent>
    </Tooltip>
  ) : (
    button
  )
}

const unifiedDialogSizeClass: Record<UnifiedDialogSize, string> = {
  confirm: 'sm:max-w-[420px]',
  form: 'sm:max-w-[480px]',
  list: 'sm:max-w-[520px]',
  // The review keeps its final bounds while the panes fill and the dialog fades in.
  review:
    'flex h-[min(28rem,calc(100dvh-3rem))] flex-col sm:max-w-[680px] data-[state=open]:[--tw-enter-scale:1]! data-[state=closed]:[--tw-exit-scale:1]!'
}

function DialogContent({
  className,
  children,
  overlayClassName,
  showCloseButton,
  closeButtonVariant = 'close',
  surface,
  density,
  size,
  scrollable = false,
  phoneSheet = false,
  busy = false,
  initialFocus,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> &
  VariantProps<typeof dialogContentVariants> & {
    overlayClassName?: string
    /** Defaults on, except for the unified sizes, whose footer Cancel closes instead. */
    showCloseButton?: boolean
    closeButtonVariant?: 'close' | 'minimize'
    /** `compact` is a short confirmation's width, like the close prompts. `confirm`, `form` and
     *  `list` are the unified layout: one padding and type scale, footer with a start slot. */
    size?: 'default' | 'compact' | 'flush' | UnifiedDialogSize
    /** The whole dialog scrolls within the viewport instead of growing past it. */
    scrollable?: boolean
    /** In a phone-width window it sits on the bottom edge, full width, as a bottom sheet. */
    phoneSheet?: boolean
    /** Work is running: Esc, outside presses and `DialogCancel` cannot close the dialog. */
    busy?: boolean
    /** `cancel` starts focus on the `DialogCancel`, for destructive and trust decisions. */
    initialFocus?: 'cancel'
  }) {
  const { ref: focusScopeRef, scope } = useOverlayFocusScope(props.ref)
  const unified = isUnifiedDialogSize(size)
  const layout = React.useMemo<DialogLayout>(() => ({ unified, busy }), [unified, busy])
  const { onOpenAutoFocus, onPointerDownOutside, onInteractOutside } = props
  return (
    <DialogPortal data-slot="dialog-portal">
      <DialogOverlay
        className={overlayClassName}
        scrim={surface === 'media' || surface === 'media-gallery' ? 'dark' : 'default'}
      />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        data-size={size}
        // Match dropdown surface/border/shadow tokens for dark-mode contrast; minmax(0,1fr) prevents long tokens from widening the grid and pushing footers outside.
        className={cn(
          'fixed top-[50%] left-[50%] z-50 grid w-full max-w-[calc(100%-2rem)] grid-cols-[minmax(0,1fr)] translate-x-[-50%] translate-y-[-50%] gap-4 rounded-lg border border-black/14 bg-dialog-surface p-6 text-foreground shadow-[0_20px_60px_rgba(0,0,0,0.28),inset_0_1px_0_rgba(255,255,255,0.08)] duration-200 outline-none dark:border-white/14 dark:shadow-[0_24px_72px_rgba(0,0,0,0.55),inset_0_1px_0_rgba(255,255,255,0.06)] data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 sm:max-w-lg data-[size=compact]:sm:max-w-sm data-[size=flush]:gap-0 data-[size=flush]:p-0',
          unified &&
            cn(
              'gap-3 rounded-[10px] p-5 [&_[data-slot=checkbox][data-state=unchecked]]:border-muted-foreground',
              unifiedDialogSizeClass[size]
            ),
          dialogContentVariants({ density, surface }),
          scrollable && 'max-h-[calc(100vh-3rem)] overflow-y-auto scrollbar-sleek',
          phoneSheet &&
            'max-sm:top-auto max-sm:bottom-0 max-sm:left-0 max-sm:max-w-full max-sm:translate-x-0 max-sm:translate-y-0 max-sm:rounded-b-none',
          className
        )}
        {...props}
        ref={focusScopeRef}
        onOpenAutoFocus={(event) => {
          onOpenAutoFocus?.(event)
          if (event.defaultPrevented || initialFocus !== 'cancel') {
            return
          }
          const cancel =
            event.target instanceof HTMLElement
              ? event.target.querySelector<HTMLElement>('[data-dialog-cancel]')
              : null
          if (cancel && !cancel.matches(':disabled')) {
            event.preventDefault()
            cancel.focus()
          }
        }}
        onPointerDownOutside={(event) => {
          if (busy) {
            event.preventDefault()
          }
          onPointerDownOutside?.(event)
        }}
        onInteractOutside={(event) => {
          if (busy) {
            event.preventDefault()
          }
          onInteractOutside?.(event)
        }}
        onCloseAutoFocus={(event) => handleOverlayCloseAutoFocus(event, props.onCloseAutoFocus)}
        onEscapeKeyDown={(event) => {
          if (busy) {
            event.preventDefault()
            return
          }
          handleImeOverlayEscape(event, props.onEscapeKeyDown)
        }}
      >
        <OverlayFocusScope value={scope}>
          <DialogLayoutContext.Provider value={layout}>
            {children}
            {(showCloseButton ?? !unified) && !busy && (
              <DialogContentCloseButton variant={closeButtonVariant} />
            )}
          </DialogLayoutContext.Provider>
        </OverlayFocusScope>
      </DialogPrimitive.Content>
    </DialogPortal>
  )
}

function DialogHeader({ className, ...props }: React.ComponentProps<'div'>) {
  const { unified } = useDialogLayout()
  return (
    <div
      data-slot="dialog-header"
      className={cn(
        'flex flex-col gap-2 text-center sm:text-left',
        unified && 'gap-0.5 text-left',
        className
      )}
      {...props}
    />
  )
}

// Why data-slot: a Radix checkbox is also a <button> and must keep its own box.
const unifiedFooterButtonClass =
  '[&>[data-slot=button]]:h-auto [&>[data-slot=button]]:min-h-8 [&>[data-slot=button]]:text-[13px] [&>[data-slot=button]]:max-w-full [&>[data-slot=button]]:py-1.5 [&>[data-slot=button]]:text-center [&>[data-slot=button]]:whitespace-normal [&>[data-slot=button]]:[overflow-wrap:anywhere]'

// Why: a ghost action's text lines up with the dialog's left edge, like the link-style extras.
const unifiedFooterStartClass = 'has-[>[data-variant=ghost]:first-child]:-ml-3'

function DialogFooter({
  className,
  showCloseButton = false,
  start,
  variant = 'default',
  children,
  ...props
}: React.ComponentProps<'div'> & {
  showCloseButton?: boolean
  /** Unified layout only: one extra on the left (a link, a ghost action or "Don't ask again"). */
  start?: React.ReactNode
  /** `bar`: a full-width footer strip with a top divider, for edge-to-edge dialogs (p-0). */
  variant?: 'default' | 'bar'
}) {
  const t = useTranslate()
  const { unified } = useDialogLayout()
  const closeButton = showCloseButton && (
    <DialogPrimitive.Close asChild>
      <Button variant="outline" size={unified ? 'sm' : 'default'}>
        {t('auto.components.ui.dialog.f26c4baeda', 'Close')}
      </Button>
    </DialogPrimitive.Close>
  )
  if (unified) {
    // Why one wrapping row: the action group moves below the start item instead of clipping.
    // A label too long for the row wraps inside its button rather than truncating.
    return (
      <div
        data-slot="dialog-footer"
        className={cn(
          'mt-2 flex flex-wrap items-center gap-2',
          variant === 'bar' && 'mt-0 border-t border-border px-4 py-3',
          className
        )}
        {...props}
      >
        {start ? (
          <div
            data-slot="dialog-footer-start"
            className={cn(
              'flex min-w-0 items-center gap-2',
              unifiedFooterButtonClass,
              unifiedFooterStartClass
            )}
          >
            {start}
          </div>
        ) : null}
        <div
          data-slot="dialog-footer-actions"
          className={cn(
            'ml-auto flex max-w-full flex-wrap items-center justify-end gap-2',
            unifiedFooterButtonClass
          )}
        >
          {children}
          {closeButton}
        </div>
      </div>
    )
  }
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        'flex flex-col-reverse gap-2 sm:flex-row sm:justify-end',
        variant === 'bar' && 'border-t border-border px-4 py-3',
        className
      )}
      {...props}
    >
      {children}
      {closeButton}
    </div>
  )
}

function DialogTitle({
  className,
  size = 'default',
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title> & {
  /** `display` is the large headline of the two-column feature tip dialogs; `compact` is a short
   *  confirmation's title. */
  size?: 'default' | 'display' | 'compact'
}) {
  const { unified } = useDialogLayout()
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      data-size={size}
      className={cn(
        'text-lg leading-snug font-semibold break-words data-[size=compact]:text-sm data-[size=display]:text-2xl data-[size=display]:leading-tight data-[size=display]:tracking-tight md:data-[size=display]:text-[1.75rem]',
        unified && 'text-[15px] data-[size=compact]:text-[15px]',
        className
      )}
      {...props}
    />
  )
}

function DialogDescription({
  className,
  size = 'default',
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description> & {
  /** `compact` pairs with a compact title in a short confirmation; in the unified layout it is
   *  the 12px meta line under the title. */
  size?: 'default' | 'compact'
}) {
  const { unified } = useDialogLayout()
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      data-size={size}
      className={cn(
        'text-sm text-muted-foreground data-[size=compact]:text-xs',
        unified && 'text-[13px] leading-normal',
        className
      )}
      {...props}
    />
  )
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger
}
