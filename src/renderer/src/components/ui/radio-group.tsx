import * as React from 'react'
import * as RadioGroupPrimitive from 'radix-ui/radio-group'
import { cva, type VariantProps } from 'class-variance-authority'
import { Circle } from 'lucide-react'
import { cn } from '@/lib/class-names'

const radioGroupVariants = cva('', {
  variants: {
    layout: {
      default: 'grid gap-2',
      // Sidebar-style rows carry their own padding.
      // Why: an auto column widens to a row's nowrap text; grid-cols-1 lets rows truncate.
      rows: 'grid grid-cols-1 gap-0.5',
      cards: 'grid gap-3 md:grid-cols-2',
      inline: 'flex flex-wrap items-center gap-2.5'
    }
  },
  defaultVariants: { layout: 'default' }
})

const radioGroupItemVariants = cva(
  'shrink-0 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50',
  {
    variants: {
      variant: {
        default: 'size-4 rounded-full border border-input text-primary',
        card: 'size-auto overflow-hidden rounded-xl border border-border p-3 text-left text-foreground transition-colors hover:bg-accent/60 data-[state=checked]:border-foreground/60 data-[state=checked]:bg-accent',
        // Preview tile above a caption; children read the checked state via group-data-[state=checked].
        media:
          'group flex size-auto flex-col overflow-hidden rounded-xl border border-border bg-card text-left text-foreground transition-colors hover:border-foreground/30 data-[state=checked]:border-foreground/50 data-[state=checked]:ring-[3px] data-[state=checked]:ring-ring/25 data-[state=checked]:focus-visible:ring-ring/60',
        pill: 'inline-flex h-6 items-center gap-1.5 rounded-full border border-border px-2.5 text-xs font-medium text-foreground transition-colors hover:bg-accent/60 data-[state=checked]:border-foreground/60 data-[state=checked]:bg-accent'
      }
    },
    defaultVariants: { variant: 'default' }
  }
)

function RadioGroup({
  className,
  layout = 'default',
  ...props
}: React.ComponentProps<typeof RadioGroupPrimitive.Root> &
  VariantProps<typeof radioGroupVariants>) {
  return (
    <RadioGroupPrimitive.Root
      data-slot="radio-group"
      data-layout={layout}
      className={cn(radioGroupVariants({ layout }), className)}
      {...props}
    />
  )
}

function RadioGroupItem({
  className,
  children,
  variant = 'default',
  ...props
}: React.ComponentProps<typeof RadioGroupPrimitive.Item> &
  VariantProps<typeof radioGroupItemVariants>) {
  return (
    <RadioGroupPrimitive.Item
      data-slot="radio-group-item"
      data-variant={variant}
      className={cn(radioGroupItemVariants({ variant }), className)}
      {...props}
    >
      {children ?? (
        <RadioGroupPrimitive.Indicator className="flex items-center justify-center">
          <Circle className="size-2 fill-current" />
        </RadioGroupPrimitive.Indicator>
      )}
    </RadioGroupPrimitive.Item>
  )
}

/** A radio whose look is its one child: the group's arrow keys and single Tab stop, on any row. */
function RadioGroupItemSlot(
  props: Omit<React.ComponentProps<typeof RadioGroupPrimitive.Item>, 'asChild'>
) {
  return <RadioGroupPrimitive.Item data-slot="radio-group-item" asChild {...props} />
}

export { RadioGroup, RadioGroupItem, RadioGroupItemSlot }
