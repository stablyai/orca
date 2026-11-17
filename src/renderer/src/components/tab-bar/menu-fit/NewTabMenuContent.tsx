import React, { useCallback, useState } from 'react'
import { DropdownMenuContent } from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/class-names'
import { NewTabMenuFitProvider } from './NewTabMenuFitProvider'

/** The + menu's content: fits its agent list to the screen for the session it is open. */
export function NewTabMenuContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof DropdownMenuContent>): React.JSX.Element {
  // Why: Radix re-prefers bottom on every update, so an upward menu would jump below "+" as a search shrinks it.
  const [preferTop, setPreferTop] = useState(false)
  const onPlacedSide = useCallback((side: string | null) => setPreferTop(side === 'top'), [])
  return (
    <DropdownMenuContent
      collisionPadding={8}
      {...props}
      side={preferTop ? 'top' : props.side}
      // While the whole menu scrolls, keep keyboard focus clear of its bottom fade.
      className={cn('has-[>[data-new-tab-menu-fit=menu]]:scroll-pb-[34px]', className)}
    >
      <NewTabMenuFitProvider onPlacedSide={onPlacedSide}>{children}</NewTabMenuFitProvider>
    </DropdownMenuContent>
  )
}
