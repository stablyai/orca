import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import * as Slot from 'radix-ui/slot'

import { cn } from '@/lib/utils'

const outlineButtonClasses =
  'border border-border bg-background text-foreground shadow-xs hover:border-muted-foreground/35 hover:bg-accent hover:text-accent-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50'

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-md cursor-pointer text-sm font-medium whitespace-nowrap transition-all outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary/90',
        destructive:
          'bg-destructive text-white hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:bg-destructive/60 dark:focus-visible:ring-destructive/40',
        outline: outlineButtonClasses,
        'orchestration-tab': `${outlineButtonClasses} border-(--crew-border) bg-(--crew-surface) text-card-foreground shadow-floating dark:border-(--crew-border) dark:bg-(--crew-surface) dark:hover:bg-accent dark:hover:text-accent-foreground`,
        secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/80',
        ghost: 'hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50',
        link: 'text-primary underline-offset-4 hover:underline',
        'menu-launch':
          'min-w-0 flex-1 justify-start rounded-l-[7px] rounded-r-none text-foreground',
        'menu-segment': 'rounded-l-none border-l border-border',
        'pane-title': 'pane-title-split-trigger',
        'pane-title-close': 'pane-title-close',
        // The worktree card's "rename failed" chip, for a failure the user can open.
        'destructive-chip':
          'border border-destructive/40 bg-destructive/10 text-destructive hover:bg-destructive/15 hover:text-destructive'
      },
      size: {
        default: 'h-9 px-4 py-2 has-[>svg]:px-3',
        xs: "h-6 gap-1 rounded-md px-2 text-xs has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3",
        inline: 'h-6 gap-1 px-0 has-[>svg]:px-0',
        // A ghost name inside a row label: `inline`'s height, padded so its hover fill clears the text.
        inlineChip: 'h-6 gap-1 px-1.5',
        sm: 'h-8 gap-1.5 rounded-md px-3 has-[>svg]:px-2.5',
        menu: 'h-8 gap-2 px-2 py-1.5 text-xs leading-5',
        lg: 'h-10 rounded-md px-6 has-[>svg]:px-4',
        icon: 'size-9',
        'icon-xs': "size-6 rounded-md [&_svg:not([class*='size-'])]:size-3",
        // The dictation pill's round finish button.
        'icon-xs-round': "size-6 rounded-full [&_svg:not([class*='size-'])]:size-3",
        'icon-sm': 'size-8',
        'icon-lg': 'size-10',
        // As tall as the composer's round Send button, so swapping between them keeps the row's height.
        pill: 'h-8 gap-1.5 rounded-full px-3 has-[>svg]:px-2.5 pointer-coarse:h-10',
        chip: "h-4 gap-0.5 rounded px-0.5 text-[10px] leading-none has-[>svg]:px-0.5 [&_svg:not([class*='size-'])]:size-2.5"
      }
    },
    defaultVariants: {
      variant: 'default',
      size: 'default'
    }
  }
)

const Button = React.forwardRef<
  HTMLButtonElement,
  React.ComponentProps<'button'> &
    VariantProps<typeof buttonVariants> & {
      asChild?: boolean
    }
>(function Button(
  { className, variant = 'default', size = 'default', asChild = false, ...props },
  ref
) {
  const Comp = asChild ? Slot.Root : 'button'

  return (
    <Comp
      ref={ref}
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
})

export { Button, buttonVariants }
