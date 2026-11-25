import { useCallback, useEffect, useRef } from 'react'

const MAX_TRIES = 3

type Read = { tries: number; pending: boolean; loader: (anchor: string) => Promise<void> }

/** Asks the host for the details window around a row: never twice at once, and at most three
 *  times per roster change, so a failed read can be retried (a key press, a scroll) but a row the
 *  host never sends cannot loop. */
export function useWorkerDockDetailReads(
  identities: unknown,
  loadWindow: ((anchor: string) => Promise<void>) | undefined
): (anchor: string) => void {
  const reads = useRef(new Map<string, Read>())
  // A roster change resets the budget, but a read still running keeps its place (the same entry):
  // it is the same request, and its reply or failure is what frees the anchor for the next one.
  useEffect(() => {
    reads.current = new Map(
      [...reads.current].flatMap(([anchor, read]) => {
        if (!read.pending) {
          return []
        }
        read.tries = 1
        return [[anchor, read] as const]
      })
    )
  }, [identities])
  return useCallback(
    (anchor: string) => {
      if (!loadWindow) {
        return
      }
      // A read another feed started (the host feed was replaced) does not hold this one back.
      const known = reads.current.get(anchor)
      const read: Read =
        known?.loader === loadWindow ? known : { tries: 0, pending: false, loader: loadWindow }
      if (read.pending || read.tries >= MAX_TRIES) {
        return
      }
      read.tries++
      read.pending = true
      reads.current.set(anchor, read)
      void loadWindow(anchor)
        .catch(() => {})
        .finally(() => {
          // Only this request's own entry: a newer feed's entry for the anchor stays as it is.
          read.pending = false
        })
    },
    [loadWindow]
  )
}
