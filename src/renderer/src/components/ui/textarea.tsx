import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '@/lib/utils'
import { ImeTextarea } from '@/lib/ime-text-field'

const textareaVariants = cva('', {
  variants: {
    variant: {
      default: '',
      code: 'font-mono',
      cell: 'h-full min-h-0 resize-none rounded-none border-0 px-2 py-0 font-mono text-xs shadow-none md:text-xs focus-visible:ring-1 focus-visible:ring-inset'
    }
  },
  defaultVariants: { variant: 'default' }
})

const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.ComponentProps<'textarea'> & VariantProps<typeof textareaVariants>
>(({ className, variant, ...props }, ref) => {
  return (
    <ImeTextarea
      ref={ref}
      data-slot="textarea"
      // Why scrollbar-sleek here: a textarea scrolls without an overflow class,
      // so it escapes the scrollbar lint rule and paints Chromium's default
      // light scrollbar on dark surfaces.
      className={cn(
        'scrollbar-sleek min-h-16 w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-2 text-base shadow-xs transition-[color,box-shadow] outline-none placeholder:text-muted-foreground/60 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm dark:bg-input/30',
        'focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50',
        'aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40',
        textareaVariants({ variant }),
        className
      )}
      {...props}
    />
  )
})

Textarea.displayName = 'Textarea'

export { Textarea }
