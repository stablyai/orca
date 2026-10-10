import type { ComponentProps, HTMLAttributes } from 'react'
import {
  isImeOwnedKeyboardEvent,
  useImeEnterGestureOwnership
} from './ime-composition-keyboard-event'

/** Keeps candidate keys out of field actions and bubbling form shortcuts. */
export function useImeTextFieldProps<T extends HTMLInputElement | HTMLTextAreaElement>(
  props: HTMLAttributes<T>
): HTMLAttributes<T> {
  const ime = useImeEnterGestureOwnership()
  return {
    onKeyDown(event) {
      if (ime.ownsKeyDown(event) || ime.isComposing() || isImeOwnedKeyboardEvent(event)) {
        event.stopPropagation()
        return
      }
      props.onKeyDown?.(event)
    },
    onKeyUp(event) {
      ime.onKeyUp(event)
      props.onKeyUp?.(event)
    },
    onCompositionStart(event) {
      ime.setComposing(true)
      props.onCompositionStart?.(event)
    },
    onCompositionEnd(event) {
      ime.onCompositionEnd()
      props.onCompositionEnd?.(event)
    },
    onBlur(event) {
      ime.reset()
      props.onBlur?.(event)
    }
  }
}

export function ImeInput(props: ComponentProps<'input'>): React.JSX.Element {
  const imeProps = useImeTextFieldProps<HTMLInputElement>(props)
  return <input {...props} {...imeProps} />
}

export function ImeTextarea(props: ComponentProps<'textarea'>): React.JSX.Element {
  const imeProps = useImeTextFieldProps<HTMLTextAreaElement>(props)
  return <textarea {...props} {...imeProps} />
}
