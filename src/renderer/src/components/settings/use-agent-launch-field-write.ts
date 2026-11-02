import { useRef, useState } from 'react'

export function useAgentLaunchFieldWrite(): {
  pending: boolean
  write: (value: string, save: () => void | Promise<void>, onSaved?: () => void) => void
} {
  const tail = useRef<Promise<void> | null>(null)
  const queuedValues = useRef(new Set<string>())
  const [pending, setPending] = useState(false)
  const write = (value: string, save: () => void | Promise<void>, onSaved?: () => void): void => {
    if (queuedValues.current.has(value)) {
      return
    }
    const result = tail.current ? tail.current.then(save) : save()
    if (!result) {
      onSaved?.()
      return
    }
    queuedValues.current.add(value)
    setPending(true)
    const completion: Promise<void> = result
      .then(onSaved)
      .catch(() => {})
      .finally(() => {
        queuedValues.current.delete(value)
        if (tail.current === completion) {
          tail.current = null
          setPending(false)
        }
      })
    tail.current = completion
  }
  return { pending, write }
}
