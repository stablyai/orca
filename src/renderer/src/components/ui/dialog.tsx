'use client'

import { SECURITY_SURFACE_CLASS } from './security-surface'
import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { Minus, XIcon } from 'lucide-react'
import * as DialogPrimitive from 'radix-ui/dialog'

import { cn } from '@/lib/utils'
import { handleImeOverlayEscape } from '@/lib/ime-overlay-escape'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'

function Dialog({ ...props }: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />
}

function DialogTrigger({ ...props }: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />
}

function DialogPortal({ ...props }: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />
}

function DialogClose({ ...props }: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />
}

function DialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      // Deepen and blur the scrim so it remains visible over the near-black dark canvas.
      className={cn(
        'fixed inset-0 z-50 bg-black/55 backdrop-blur-[2px] data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0',
        className
      )}
      {...props}
    />
  )
}

const dialogContentSurfaceVariants = cva('', {
  variants: {
    surface: {
      default: '',
      /** The tinted, edge-to-edge panel of the two-column feature tip dialogs. */
      'feature-tip':
        'gap-0 bg-[color-mix(in_srgb,var(--foreground)_8%,var(--background))] p-0 dark:bg-[color-mix(in_srgb,var(--foreground)_16%,var(--background))]',
      /** Edge to edge, for an embedded panel that brings its own header and padding. */
      panel: 'gap-0 p-0',
      /** Trust, consent and provenance decisions: host-owned tokens a plugin theme cannot restyle. */
      security: SECURITY_SURFACE_CLASS
    }
  },
  defaultVariants: { surface: 'default' }
})

function DialogContentCloseButton({ variant }: { variant: 'close' | 'minimize' }) {
  const label =
    variant === 'minimize'
      ? translate('auto.components.ui.dialog.minimize', 'Minimize')
      : translate('auto.components.ui.dialog.f26c4baeda', 'Close')
  const button = (
    <DialogPrimitive.Close
      data-slot="dialog-close"
      className="absolute top-4 right-4 rounded-xs opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:outline-hidden disabled:pointer-events-none data-[state=open]:bg-accent data-[state=open]:text-muted-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4"
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

function DialogContent({
  className,
  children,
  overlayClassName,
  showCloseButton = true,
  closeButtonVariant = 'close',
  surface,
  size,
  scrollable = false,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> &
  VariantProps<typeof dialogContentSurfaceVariants> & {
    overlayClassName?: string
    showCloseButton?: boolean
    closeButtonVariant?: 'close' | 'minimize'
    /** `compact` is a short confirmation's width, like the close prompts. */
    size?: 'default' | 'compact'
    /** The whole dialog scrolls within the viewport instead of growing past it. */
    scrollable?: boolean
  }) {
  return (
    <DialogPortal data-slot="dialog-portal">
      <DialogOverlay className={overlayClassName} />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        data-size={size}
        // Match dropdown surface/border/shadow tokens for dark-mode contrast; minmax(0,1fr) prevents long tokens from widening the grid and pushing footers outside.
        className={cn(
          'fixed top-[50%] left-[50%] z-50 grid w-full max-w-[calc(100%-2rem)] grid-cols-[minmax(0,1fr)] translate-x-[-50%] translate-y-[-50%] gap-4 rounded-lg border border-black/14 bg-background/96 p-6 text-foreground shadow-[0_20px_60px_rgba(0,0,0,0.28),inset_0_1px_0_rgba(255,255,255,0.08)] backdrop-blur-2xl duration-200 outline-none dark:border-white/14 dark:bg-[rgba(23,23,23,0.96)] dark:shadow-[0_24px_72px_rgba(0,0,0,0.55),inset_0_1px_0_rgba(255,255,255,0.06)] data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 sm:max-w-lg data-[size=compact]:sm:max-w-sm',
          dialogContentSurfaceVariants({ surface }),
          scrollable && 'max-h-[calc(100vh-3rem)] overflow-y-auto scrollbar-sleek',
          className
        )}
        {...props}
        onEscapeKeyDown={(event) => handleImeOverlayEscape(event, props.onEscapeKeyDown)}
      >
        {children}
        {showCloseButton && <DialogContentCloseButton variant={closeButtonVariant} />}
      </DialogPrimitive.Content>
    </DialogPortal>
  )
}

function DialogHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="dialog-header"
      className={cn('flex flex-col gap-2 text-center sm:text-left', className)}
      {...props}
    />
  )
}

function DialogFooter({
  className,
  showCloseButton = false,
  children,
  ...props
}: React.ComponentProps<'div'> & {
  showCloseButton?: boolean
}) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn('flex flex-col-reverse gap-2 sm:flex-row sm:justify-end', className)}
      {...props}
    >
      {children}
      {showCloseButton && (
        <DialogPrimitive.Close asChild>
          <Button variant="outline">
            {translate('auto.components.ui.dialog.f26c4baeda', 'Close')}
          </Button>
        </DialogPrimitive.Close>
      )}
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
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      data-size={size}
      className={cn(
        'text-lg leading-snug font-semibold break-words data-[size=compact]:text-sm data-[size=display]:text-2xl data-[size=display]:leading-tight data-[size=display]:tracking-tight md:data-[size=display]:text-[1.75rem]',
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
  /** `compact` pairs with a compact title in a short confirmation. */
  size?: 'default' | 'compact'
}) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      data-size={size}
      className={cn('text-sm text-muted-foreground data-[size=compact]:text-xs', className)}
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
