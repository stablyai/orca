import type { ComponentProps } from 'react'
import { useImeEnterGestureOwnership } from '@/lib/ime-composition-keyboard-event'

export function ImeEnterGuardedForm({
  onBlur,
  onCompositionEnd,
  onCompositionStart,
  onKeyDown,
  onKeyUp,
  ...props
}: ComponentProps<'form'>): React.JSX.Element {
  const imeEnter = useImeEnterGestureOwnership()

  return (
    <form
      {...props}
      onCompositionStart={(event) => {
        imeEnter.setComposing(true)
        onCompositionStart?.(event)
      }}
      onCompositionEnd={(event) => {
        imeEnter.setComposing(false)
        onCompositionEnd?.(event)
      }}
      onKeyDown={(event) => {
        if (imeEnter.ownsKeyDown(event)) {
          event.preventDefault()
          return
        }
        onKeyDown?.(event)
      }}
      onKeyUp={(event) => {
        imeEnter.onKeyUp(event)
        onKeyUp?.(event)
      }}
      onBlur={(event) => {
        imeEnter.reset()
        onBlur?.(event)
      }}
    />
  )
}
