import * as React from 'react'

import { cn } from '@/lib/utils'

/**
 * `compact` is the sidebar's field treatment, shared by the dialogs the sidebar raises.
 * `size` shadows the native character-count attribute, which nothing here uses and CSS supersedes.
 */
const Input = React.forwardRef<
  HTMLInputElement,
  Omit<React.ComponentProps<'input'>, 'size'> & { size?: 'default' | 'compact' }
>(({ className, type, size = 'default', ...props }, ref) => {
  return (
    <input
      ref={ref}
      type={type}
      data-slot="input"
      data-size={size}
      className={cn(
        'h-9 w-full min-w-0 appearance-none rounded-md border border-input bg-transparent px-3 py-1 text-base shadow-xs transition-[color,box-shadow] outline-none selection:bg-primary selection:text-primary-foreground file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground/60 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm dark:bg-input/30',
        'focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50',
        'aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40',
        size === 'compact' && 'h-8 text-xs md:text-xs',
        className
      )}
      {...props}
    />
  )
})

Input.displayName = 'Input'

export { Input }
