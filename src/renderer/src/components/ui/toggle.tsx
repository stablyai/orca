import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import * as TogglePrimitive from 'radix-ui/toggle'

import { cn } from '@/lib/class-names'

const toggleVariants = cva(
  "control-interaction inline-flex items-center justify-center gap-2 rounded-md text-sm font-medium whitespace-nowrap transition-[color,box-shadow] outline-none hover:bg-muted hover:text-muted-foreground disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 data-[state=on]:bg-accent data-[state=on]:text-accent-foreground dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: 'bg-transparent',
        outline:
          'border border-input bg-transparent shadow-xs hover:bg-accent hover:text-accent-foreground',
        // Why not bg-accent: on a light popover it is nearly the surface colour (STYLEGUIDE, list rows).
        segmented:
          'bg-transparent text-muted-foreground transition-[color,background-color,box-shadow] hover:bg-foreground/6 hover:text-foreground data-[state=on]:bg-foreground/12 data-[state=on]:text-foreground dark:hover:bg-accent/50 dark:data-[state=on]:bg-accent',
        // An outlined segmented toggle that stands alone; pressed trades its border for the fill.
        // data-pressed lets a menu trigger, whose data-state names open, show the same pressed fill.
        chip: 'border border-input bg-transparent text-muted-foreground transition-[color,background-color,box-shadow] hover:bg-foreground/6 hover:text-foreground data-[pressed=true]:border-transparent data-[pressed=true]:bg-foreground/12 data-[pressed=true]:text-foreground data-[state=on]:border-transparent data-[state=on]:bg-foreground/12 data-[state=on]:text-foreground dark:hover:bg-accent/50 dark:data-[pressed=true]:bg-accent dark:data-[state=on]:bg-accent'
      },
      size: {
        default: 'h-9 min-w-9 px-2',
        xs: 'h-6 min-w-6 px-2 text-xs',
        sm: 'h-8 min-w-8 px-1.5',
        lg: 'h-10 min-w-10 px-2.5'
      }
    },
    defaultVariants: {
      variant: 'default',
      size: 'default'
    }
  }
)

function Toggle({
  className,
  variant,
  size,
  ...props
}: React.ComponentProps<typeof TogglePrimitive.Root> & VariantProps<typeof toggleVariants>) {
  return (
    <TogglePrimitive.Root
      data-slot="toggle"
      className={cn(toggleVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Toggle, toggleVariants }
