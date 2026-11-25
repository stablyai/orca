import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '@/lib/class-names'
import { ImeInput } from '@/lib/text-input/ime/ime-text-field'

const inputVariants = cva('', {
  variants: {
    variant: {
      default: '',
      name: 'h-9.5 font-medium not-focus:text-ellipsis',
      identity:
        'h-8 border-0 bg-transparent px-0 text-xl font-semibold shadow-none md:text-xl dark:bg-transparent',
      code: 'font-mono text-xs md:text-xs',
      // A large centered name with an underline, for a dialog whose first job is naming something.
      heading:
        'h-auto rounded-none border-0 border-b bg-transparent px-9 pt-1 pb-2 text-center text-2xl font-semibold shadow-none placeholder:font-medium hover:border-ring focus-visible:border-foreground focus-visible:ring-0 md:text-2xl dark:bg-transparent'
    },
    surface: {
      default: '',
      background:
        'bg-background text-foreground placeholder:text-muted-foreground dark:bg-background',
      // A bare text run inside a field that draws its own fill, border and focus ring.
      embedded:
        'h-auto border-0 bg-transparent px-0 text-sm shadow-none focus-visible:ring-0 dark:bg-transparent',
      // Text edited in place, such as a name: one line of the surrounding type, no box, so nothing moves.
      inline:
        'h-[1lh] rounded-none border-0 bg-transparent p-0 shadow-none focus-visible:ring-0 dark:bg-transparent'
    },
    density: {
      default: '',
      // pl/pr, not px: a later sheet re-emits px-2, which would beat the leading icon's pl-8.
      compact: 'h-7 border-border bg-input/50 pr-2 pl-2 text-xs shadow-none md:text-xs'
    },
    /** Room for an absolutely positioned icon at the start, such as a search glass. */
    inset: {
      default: '',
      leadingIcon: 'pl-8',
      wideLeadingIcon: 'pl-11.25'
    },
    // Reserves room for an icon button absolutely positioned inside the field's right edge.
    adornment: {
      none: '',
      trailing: 'pr-8'
    }
  },
  defaultVariants: { variant: 'default', density: 'default', inset: 'default', adornment: 'none' }
})

const Input = React.forwardRef<
  HTMLInputElement,
  React.ComponentProps<'input'> & VariantProps<typeof inputVariants>
>(({ className, type, variant, surface, density, inset, adornment, ...props }, ref) => {
  return (
    <ImeInput
      ref={ref}
      type={type}
      data-slot="input"
      className={cn(
        'h-9 w-full min-w-0 appearance-none rounded-md border border-input bg-transparent px-3 py-1 text-base shadow-xs transition-[color,box-shadow] outline-none selection:bg-primary selection:text-primary-foreground file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 aria-disabled:opacity-50 md:text-sm dark:bg-input/30',
        'focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50',
        'aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40',
        inputVariants({ variant, surface, density, inset, adornment }),
        className
      )}
      {...props}
    />
  )
})

Input.displayName = 'Input'

export { Input }
