import { useCallback, useRef, useState } from 'react'
import type { CloudReadWake } from '../orca-cloud/read-snapshot/CloudReadSnapshotView'

/**
 * The Asleep workspace whose read-only copy is open (opening it never wakes it), plus a wake
 * started from that panel, shown there (elapsed, slow, failed) until the workspace opens.
 */
export function useCloudReadPanel() {
  const [readingId, setReadingIdState] = useState<string | null>(null)
  const [readWake, setReadWake] = useState<CloudReadWake | null>(null)
  const readingRef = useRef<string | null>(null)
  const setReadingId = useCallback(
    (next: string | null | ((id: string | null) => string | null)) => {
      const value = typeof next === 'function' ? next(readingRef.current) : next
      if (value !== readingRef.current) {
        setReadWake(null)
      }
      readingRef.current = value
      setReadingIdState(value)
    },
    []
  )
  return { readingId, readingRef, setReadingId, readWake, setReadWake }
}
