import { useEffect, useState } from 'react'
import { yieldToEventLoop } from '../../../../shared/event-loop-yield'

export function usePaintDeferredValue<T>(value: T): T {
  const [deferred, setDeferred] = useState(value)

  useEffect(() => {
    if (Object.is(value, deferred)) {
      return
    }
    let current = true
    const frameId = requestAnimationFrame(() => {
      void yieldToEventLoop().then(() => {
        if (current) {
          setDeferred(value)
        }
      })
    })
    return () => {
      current = false
      cancelAnimationFrame(frameId)
    }
  }, [deferred, value])

  return deferred
}
