import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '@/lib/class-names'

const buttonGroupVariants = cva(
  "flex w-fit items-stretch has-[>[data-slot=button-group]]:gap-2 [&>*]:focus-visible:relative [&>*]:focus-visible:z-10 has-[select[aria-hidden=true]:last-child]:[&>[data-slot=select-trigger]:last-of-type]:rounded-r-md [&>[data-slot=select-trigger]:not([class*='w-'])]:w-fit [&>input]:flex-1",
  {
    variants: {
      orientation: {
        horizontal:
          '[&>*:not(:first-child)]:rounded-l-none [&>*:not(:first-child)]:border-l-0 [&>*:not(:last-child)]:rounded-r-none',
        vertical:
          'flex-col [&>*:not(:first-child)]:rounded-t-none [&>*:not(:first-child)]:border-t-0 [&>*:not(:last-child)]:rounded-b-none'
      },
      // A split button (action + chevron): the chevron half is narrow, behind a 1px divider.
      // `:not(:first-child)` outranks the orientation's border-l-0 and the button size's padding.
      split: {
        none: '',
        solid:
          'shrink-0 [&>:not(:first-child)]:border-l [&>:not(:first-child)]:border-l-primary-foreground/20 [&>:not(:first-child)]:px-1',
        subtle:
          'shrink-0 [&>:not(:first-child)]:border-l [&>:not(:first-child)]:border-l-border [&>:not(:first-child)]:px-1'
      }
    },
    defaultVariants: {
      orientation: 'horizontal',
      split: 'none'
    }
  }
)

function ButtonGroup({
  className,
  orientation,
  split,
  ...props
}: React.ComponentProps<'div'> & VariantProps<typeof buttonGroupVariants>) {
  return (
    <div
      role="group"
      data-slot="button-group"
      data-orientation={orientation}
      className={cn(buttonGroupVariants({ orientation, split }), className)}
      {...props}
    />
  )
}

export { ButtonGroup, buttonGroupVariants }
