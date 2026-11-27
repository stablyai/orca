import { useEffect, useRef } from 'react'

/** Settings can close (Escape, Back) without a blur; runs what blur would have saved. */
export function useSaveOnClose(save: (() => void) | null): void {
  const latest = useRef(save)
  useEffect(() => {
    latest.current = save
  })
  useEffect(() => () => latest.current?.(), [])
}
