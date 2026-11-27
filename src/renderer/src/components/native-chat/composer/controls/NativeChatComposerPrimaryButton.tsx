import type { ComponentProps } from 'react'
import { Button } from '@/components/ui/button'

/** The composer's round primary action (Send, Stop, Steer). `compact` fits a one-line box, beside its + button. */
export function NativeChatComposerPrimaryButton({
  variant = 'default',
  size = 'default',
  focusComposer,
  ...props
}: Omit<ComponentProps<typeof Button>, 'size' | 'className' | 'onMouseDown'> & {
  size?: 'default' | 'compact'
  focusComposer?: () => void
}): React.JSX.Element {
  return (
    <Button
      type="button"
      variant={variant}
      size={size === 'compact' ? 'icon-round-compact' : 'icon-round'}
      {...props}
      onMouseDown={(event) => {
        // A press keeps focus where it was; a focused button drops it to <body> when it disables.
        event.preventDefault()
        // Except in another split's chat editor, where Cmd/Ctrl+Enter would still send that chat's draft.
        const button = event.currentTarget
        const focusedChat = button.ownerDocument.activeElement
          ?.closest('[data-native-chat-prompt-editor]')
          ?.closest('[data-native-chat-root]')
        if (event.button === 0 && focusedChat && !focusedChat.contains(button)) {
          focusComposer?.()
        }
      }}
    />
  )
}
