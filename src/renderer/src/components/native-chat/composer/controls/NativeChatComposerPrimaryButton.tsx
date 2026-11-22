import type { ComponentProps } from 'react'
import { Button } from '@/components/ui/button'

/** The composer's round primary action (Send, Stop, Steer). `compact` fits a one-line box, beside its + button. */
export function NativeChatComposerPrimaryButton({
  variant = 'default',
  size = 'default',
  ...props
}: Omit<ComponentProps<typeof Button>, 'size' | 'className' | 'onMouseDown'> & {
  size?: 'default' | 'compact'
}): React.JSX.Element {
  return (
    <Button
      type="button"
      variant={variant}
      size={size === 'compact' ? 'icon-round-compact' : 'icon-round'}
      {...props}
      // A press keeps focus where it was; a focused button drops it to <body> when it disables.
      onMouseDown={(event) => event.preventDefault()}
    />
  )
}
