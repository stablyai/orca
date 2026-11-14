import type React from 'react'
import { Button } from '@/components/ui/button'

// Every Commits header action shares this so new ones keep the same size and muted color.
export function CommitsHeaderIconButton(
  props: Omit<React.ComponentProps<typeof Button>, 'className' | 'variant' | 'size'>
): React.JSX.Element {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      className="my-auto h-auto w-auto p-0.5 text-muted-foreground hover:bg-transparent hover:text-muted-foreground dark:hover:bg-transparent [&_svg]:size-3"
      {...props}
    />
  )
}
