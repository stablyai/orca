import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '@/lib/utils'
import { ImeInput } from '@/lib/ime-text-field'

const inputVariants = cva(
  'w-full min-w-0 appearance-none rounded-md border border-input bg-transparent px-3 py-1 shadow-xs transition-[color,box-shadow] outline-none selection:bg-primary selection:text-primary-foreground file:inline-flex file:h-7 file:border-0 file:bg-transparent file:font-medium file:text-foreground placeholder:text-muted-foreground/60 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:bg-input/30 dark:aria-invalid:ring-destructive/40',
  {
    variants: {
      variant: {
        default: 'h-9 text-base md:text-sm file:text-sm',
        'compact-mono': 'h-7 font-mono text-xs file:text-xs'
      }
    },
    defaultVariants: {
      variant: 'default'
    }
  }
)

const Input = React.forwardRef<
  HTMLInputElement,
  React.ComponentProps<'input'> & VariantProps<typeof inputVariants>
>(({ className, type, variant, ...props }, ref) => {
  return (
    <ImeInput
      ref={ref}
      type={type}
      data-slot="input"
      className={cn(inputVariants({ variant, className }))}
      {...props}
    />
  )
})

Input.displayName = 'Input'

export { Input }
