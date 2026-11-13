import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '@/lib/class-names'
import { ImeInput } from '@/lib/text-input/ime/ime-text-field'

const inputVariants = cva('', {
  variants: {
    variant: {
      default: '',
      code: 'font-mono text-xs md:text-xs',
      omnibox:
        'border-0 bg-transparent px-0 text-xs font-normal text-foreground shadow-none placeholder:font-normal placeholder:text-muted-foreground focus-visible:border-0 focus-visible:ring-0 aria-invalid:border-0 aria-invalid:ring-0 md:text-xs dark:bg-transparent'
    },
    highlighted: {
      true: 'ring-2 ring-ring/20 focus-visible:ring-2 focus-visible:ring-ring/20',
      false: ''
    },
    surface: {
      default: '',
      background:
        'bg-background text-foreground placeholder:text-muted-foreground dark:bg-background',
      // A bare text run inside a field that draws its own fill, border and focus ring.
      embedded:
        'h-auto border-0 bg-transparent px-0 text-sm shadow-none focus-visible:ring-0 dark:bg-transparent'
    },
    density: {
      default: '',
      compact: 'h-7 border-border bg-input/50 px-2 text-xs shadow-none md:text-xs'
    },
    // Reserves room for an icon button absolutely positioned inside the field's right edge.
    adornment: {
      none: '',
      trailing: 'pr-8'
    }
  },
  compoundVariants: [
    {
      variant: 'omnibox',
      highlighted: true,
      className: 'border border-ring px-2 focus-visible:border-ring'
    }
  ],
  defaultVariants: { variant: 'default', density: 'default', adornment: 'none' }
})

const Input = React.forwardRef<
  HTMLInputElement,
  React.ComponentProps<'input'> & VariantProps<typeof inputVariants>
>(({ className, type, variant, highlighted, surface, density, adornment, ...props }, ref) => {
  return (
    <ImeInput
      ref={ref}
      type={type}
      data-slot="input"
      data-highlighted={highlighted || undefined}
      className={cn(
        'h-9 w-full min-w-0 appearance-none rounded-md border border-input bg-transparent px-3 py-1 text-base shadow-xs transition-[color,box-shadow] outline-none selection:bg-primary selection:text-primary-foreground file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm dark:bg-input/30',
        'focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50',
        'aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40',
        inputVariants({ variant, highlighted, surface, density, adornment }),
        className
      )}
      {...props}
    />
  )
})

Input.displayName = 'Input'

export { Input }
