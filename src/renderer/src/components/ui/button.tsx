import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import * as Slot from 'radix-ui/slot'

import { cn } from '@/lib/class-names'

const outlineButtonClasses =
  'border border-border bg-background text-foreground shadow-xs hover:border-muted-foreground/35 hover:bg-accent hover:text-accent-foreground dark:border-input dark:bg-input/30 dark:hover:bg-input/50'

const disabledOnAccentButtonClasses =
  'disabled:bg-accent disabled:text-muted-foreground disabled:opacity-100 disabled:hover:bg-accent disabled:hover:text-muted-foreground'

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-md cursor-pointer text-sm font-medium whitespace-nowrap transition-[color,background-color,opacity] outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 aria-disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary/90',
        destructive:
          'bg-destructive text-white hover:bg-destructive/90 focus-visible:border-destructive focus-visible:ring-destructive/40 dark:bg-destructive/60 dark:focus-visible:ring-destructive/50',
        outline: outlineButtonClasses,
        'orchestration-tab': `${outlineButtonClasses} border-(--crew-border) bg-(--crew-surface) text-card-foreground shadow-floating dark:border-(--crew-border) dark:bg-(--crew-surface) dark:hover:bg-accent dark:hover:text-accent-foreground`,
        // An outline that must read as a control on a card: its border reaches 3:1 in both themes.
        'outline-strong': `${outlineButtonClasses} border-muted-foreground/75 hover:border-muted-foreground dark:border-muted-foreground/60 dark:hover:border-muted-foreground`,
        secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/80',
        ghost: 'hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50',
        // A row action over its hovered row's accent fill, where ghost's accent hover would not show.
        'ghost-on-accent': `text-accent-foreground hover:bg-foreground/10 ${disabledOnAccentButtonClasses}`,
        // `ghost-on-accent`'s outlined partner: outline's accent hover would not show on the accent fill.
        'outline-on-accent': `${outlineButtonClasses} hover:bg-foreground/5 ${disabledOnAccentButtonClasses} disabled:border-border disabled:shadow-none disabled:hover:border-border dark:disabled:border-border dark:disabled:bg-accent dark:disabled:hover:bg-accent`,
        disclosure:
          'text-xs focus-visible:ring-inset hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50',
        // Keep icon states visible on muted fields, which share accent's light-theme fill.
        'muted-field-icon':
          'text-muted-foreground hover:bg-foreground/[0.08] hover:text-foreground focus-visible:bg-foreground/[0.08] focus-visible:text-foreground aria-expanded:bg-foreground/[0.08] aria-expanded:text-foreground data-[state=open]:bg-foreground/[0.08] data-[state=open]:text-foreground',
        // The head queued card's Steer: ghost, filled as the primary while the composer previews Steer queued.
        'queued-head-steer':
          'hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50 [[data-native-chat-root]:has([data-native-chat-steer-preview=steer-queued])_&]:bg-primary [[data-native-chat-root]:has([data-native-chat-steer-preview=steer-queued])_&]:text-primary-foreground',
        link: 'text-primary underline-offset-4 hover:underline',
        // A quiet secondary link, such as a dialog footer's "Manual steps".
        'link-muted':
          'text-muted-foreground underline-offset-4 hover:text-foreground hover:underline',
        'menu-launch':
          'min-w-0 flex-1 justify-start rounded-l-[7px] rounded-r-none text-foreground',
        'menu-segment': 'rounded-l-none border-l border-border',
        'pane-title': 'pane-title-split-trigger',
        'pane-title-close': 'pane-title-close',
        // A quiet row's Remove: text only until hover, so it does not compete with the row's actions.
        'ghost-destructive':
          'text-destructive hover:bg-destructive/10 hover:text-destructive dark:hover:bg-destructive/15',
        // A status that is also its fix, e.g. "Update in Slack": loud colour, link weight.
        'warning-link': 'text-status-warning-foreground underline-offset-4 hover:underline',
        // A chat notice's quiet icon tool: faint until hovered or open; pressed fills like a toggle.
        'chat-tool':
          'text-chat-foreground-faint hover:bg-accent hover:text-chat-foreground aria-expanded:bg-accent aria-expanded:text-chat-foreground aria-pressed:bg-foreground/10 aria-pressed:text-primary aria-pressed:hover:text-primary dark:aria-pressed:bg-accent',
        // The worktree card's "rename failed" chip, for a failure the user can open.
        'destructive-chip':
          'border border-destructive/40 bg-destructive/10 text-destructive hover:bg-destructive/15 hover:text-destructive'
      },
      size: {
        default: 'h-9 px-4 py-2 has-[>svg]:px-3',
        xs: "h-6 gap-1 rounded-md px-2 text-xs has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3",
        // A `link` inside a sentence: no box of its own, so it wraps with the text and lines up with its edge.
        inlineText:
          "h-auto gap-1 rounded-sm p-0 align-baseline text-xs [&_svg:not([class*='size-'])]:size-3",
        inline: 'h-6 gap-1 px-0 has-[>svg]:px-0',
        // A ghost name inside a row label: `inline`'s height, padded so its hover fill clears the text.
        inlineChip: 'h-6 gap-1 px-1.5',
        sm: 'h-8 gap-1.5 rounded-md px-3 has-[>svg]:px-2.5',
        'responsive-sm':
          'h-8 gap-1.5 rounded-md px-3 has-[>svg]:px-2.5 @max-xs:gap-1 @max-xs:px-1.5 @max-xs:text-xs @max-xs:has-[>svg]:px-1.5',
        menu: 'h-8 gap-2 px-2 py-1.5 text-xs leading-5',
        // A launch-menu row's label segment, matching DropdownMenuItem's `launch` rows.
        'menu-launch': 'h-9 gap-2 px-2 text-[13px] leading-4',
        lg: 'h-10 rounded-md px-6 has-[>svg]:px-4',
        icon: 'size-9',
        'icon-xs': "size-6 rounded-md [&_svg:not([class*='size-'])]:size-3",
        // The dictation pill's round finish button.
        'icon-xs-round': "size-6 rounded-full [&_svg:not([class*='size-'])]:size-3",
        'icon-sm': 'size-8',
        // The chat composer's round Send/Stop/Steer, and its compact form for one-line boxes.
        'icon-round': 'size-8 rounded-full pointer-coarse:size-10',
        'icon-round-compact': 'size-6 rounded-full pointer-coarse:size-8',
        'icon-lg': 'size-10',
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
