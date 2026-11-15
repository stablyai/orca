import { useEffect, useRef, type RefObject } from 'react'

/** Only a different draft context resets autocomplete choices; reconnecting its view does not. */
export function useNativeChatPickerContext(
  context: string,
  skillOrigin: RefObject<string | null>,
  clearDismissal: (value: null) => void
) {
  const previous = useRef(context)
  useEffect(() => {
    if (previous.current !== context) {
      previous.current = context
      skillOrigin.current = null
      clearDismissal(null)
    }
  }, [context, skillOrigin, clearDismissal])
}
