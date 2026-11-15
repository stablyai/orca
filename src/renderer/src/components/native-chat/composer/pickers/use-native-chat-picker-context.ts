import { useEffect, useEffectEvent, useRef } from 'react'

export function useNativeChatPickerContext(context: string, onChange: () => void): void {
  const previous = useRef(context)
  const changed = useEffectEvent(onChange)
  useEffect(() => {
    if (previous.current !== context) {
      previous.current = context
      changed()
    }
  }, [context])
}
