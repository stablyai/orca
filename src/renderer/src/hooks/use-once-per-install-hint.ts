import { useCallback, useEffect, useRef, useState } from 'react'
import { useAppStore } from '@/store'

export function useOncePerInstallHint(
  eligible: boolean,
  claimFirstView: () => boolean | Promise<boolean>
) {
  const persistedUIReady = useAppStore((state) => state.persistedUIReady)
  const [hintOpen, setHintOpen] = useState(false)
  const claimAttempted = useRef(false)
  const dismissed = useRef(false)
  useEffect(() => {
    if (!persistedUIReady || !eligible) {
      // Render masks ineligible hints immediately; reset so they cannot reopen later.
      if (claimAttempted.current) {
        dismissed.current = true
      }
      setHintOpen(false)
    } else if (!claimAttempted.current) {
      // Strict Mode replays effects; claim the persisted first view only once.
      claimAttempted.current = true
      const claim = claimFirstView()
      if (typeof claim === 'boolean') {
        setHintOpen(claim)
      } else {
        void claim
          .then((open) => {
            if (!dismissed.current) {
              setHintOpen(open)
            }
          })
          .catch(() => {})
      }
    }
  }, [claimFirstView, eligible, persistedUIReady])
  const dismissHint = useCallback(() => {
    dismissed.current = true
    setHintOpen(false)
  }, [])
  return { hintOpen: hintOpen && persistedUIReady && eligible, dismissHint }
}
