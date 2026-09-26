import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '@/lib/utils'

const inputVariants = cva('', {
  variants: {
    variant: {
      default: '',
      denseSearch: 'h-6 bg-muted/20 pr-2 pl-6 text-[11px] shadow-none'
    }
  },
  defaultVariants: {
    variant: 'default'
  }
})

const Input = React.forwardRef<
  HTMLInputElement,
  React.ComponentProps<'input'> & VariantProps<typeof inputVariants>
>(({ className, type, variant, ...props }, ref) => {
  return (
    <input
      ref={ref}
      type={type}
      data-slot="input"
      className={cn(
        'h-9 w-full min-w-0 appearance-none rounded-md border border-input bg-transparent px-3 py-1 text-base shadow-xs transition-[color,box-shadow] outline-none selection:bg-primary selection:text-primary-foreground file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground/60 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm dark:bg-input/30',
        'focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50',
        'aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40',
        inputVariants({ variant }),
        className
      )}
      {...props}
    />
  )
})

Input.displayName = 'Input'

export { Input, inputVariants }
