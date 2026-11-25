import * as React from 'react'
import { cn } from '@/lib/class-names'

/** An earlier crumb of a breadcrumb trail: muted text that goes to its page. */
function BreadcrumbButton({ className, ...props }: React.ComponentProps<'button'>) {
  return (
    <button
      type="button"
      data-slot="breadcrumb-button"
      className={cn(
        'min-w-0 truncate rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        className
      )}
      {...props}
    />
  )
}

export { BreadcrumbButton }
