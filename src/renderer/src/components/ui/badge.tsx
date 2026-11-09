import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import * as Slot from 'radix-ui/slot'

import { cn } from '@/lib/utils'

const badgeVariants = cva(
  'inline-flex w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-full border border-transparent px-2 py-0.5 text-xs font-medium whitespace-nowrap transition-[color,box-shadow] focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-focus-ring aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&>svg]:pointer-events-none [&>svg]:size-3',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground [a&]:hover:bg-primary/90',
        secondary: 'bg-secondary text-secondary-foreground [a&]:hover:bg-secondary/90',
        dot: 'bg-background text-foreground border-border shadow-xs dark:bg-secondary dark:border-white/20',
        destructive:
          'bg-destructive text-white focus-visible:ring-destructive/20 dark:bg-destructive/60 dark:focus-visible:ring-destructive/40 [a&]:hover:bg-destructive/90',
        outline:
          'border-border text-foreground [a&]:hover:bg-accent [a&]:hover:text-accent-foreground',
        ghost: '[a&]:hover:bg-accent [a&]:hover:text-accent-foreground',
        link: 'text-primary underline-offset-4 [a&]:hover:underline',
        /** Workspace execution-host context, quieter and squarer than status chips. */
        hostContext:
          'h-4 rounded border-border bg-[var(--host-badge,var(--accent))] px-1.5 text-[10px] leading-none text-[var(--host-badge-foreground,var(--muted-foreground))] dark:border-border/50 dark:bg-[var(--host-badge,color-mix(in_oklab,var(--accent)_80%,transparent))]',
        /** A task label inside a dense reference row's metadata line. */
        // Quiet outline tag beside a row label (e.g. a plan requirement).
        tag: 'border-border px-1.5 py-0 text-2xs text-muted-foreground',
        /** Small uppercase success chip marking the live item in a list (e.g. the active build). */
        statusActive:
          'h-4 border-status-success-border bg-status-success-background px-1.5 text-[10px] font-semibold tracking-wide text-status-success uppercase',
        referenceLabel: 'h-3.5 border-border px-1 py-0 text-3xs font-normal text-muted-foreground',
        /** An uppercase kind label set before a banner title; takes its color from the parent. */
        paneLabel:
          'h-4 border-current/30 px-1.5 py-0 align-[1px] text-3xs font-semibold tracking-wider uppercase',
        /** A skill or file sitting inline in the chat message box, ringed while selected. */
        promptPill:
          'max-w-full border-border bg-secondary px-1.5 py-0 align-baseline text-muted-foreground data-[selected=true]:ring-1 data-[selected=true]:ring-ring'
      }
    },
    defaultVariants: {
      variant: 'default'
    }
  }
)

function Badge({
  className,
  variant = 'default',
  asChild = false,
  ...props
}: React.ComponentProps<'span'> & VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : 'span'

  return (
    <Comp
      data-slot="badge"
      data-variant={variant}
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  )
}

export { Badge, badgeVariants }
