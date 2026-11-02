import { useCallback, useEffect, useRef, useState } from 'react'
import { useAppStore } from '@/store'

export function useOncePerInstallHint(eligible: boolean, claimFirstView: () => boolean) {
  const persistedUIReady = useAppStore((state) => state.persistedUIReady)
  const [hintOpen, setHintOpen] = useState(false)
  const claimAttempted = useRef(false)
  useEffect(() => {
    if (!persistedUIReady || !eligible) {
      // Render masks ineligible hints immediately; reset so they cannot reopen later.
      // oxlint-disable-next-line react-doctor/no-adjust-state-on-prop-change
      setHintOpen(false)
    } else if (!claimAttempted.current) {
      // Strict Mode replays effects; claim the persisted first view only once.
      claimAttempted.current = true
      setHintOpen(claimFirstView())
    }
  }, [claimFirstView, eligible, persistedUIReady])
  const dismissHint = useCallback(() => {
    setHintOpen(false)
  }, [])
  return { hintOpen: hintOpen && persistedUIReady && eligible, dismissHint }
}
