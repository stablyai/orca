import { useEffect, useRef } from 'react'

export function useAddRepoHostChangeReset({
  isOpen,
  selectedHostId,
  onResetClosed,
  onResetHostScopedState
}: {
  isOpen: boolean
  selectedHostId: string | null
  onResetClosed: () => void
  onResetHostScopedState: () => void
}) {
  const wasOpenRef = useRef(isOpen)
  const previousSelectedHostIdRef = useRef(selectedHostId)

  useEffect(() => {
    if (!isOpen) {
      wasOpenRef.current = false
      previousSelectedHostIdRef.current = selectedHostId
      onResetClosed()
    }
  }, [isOpen, onResetClosed, selectedHostId])

  useEffect(() => {
    if (!isOpen) {
      return
    }
    if (!wasOpenRef.current) {
      wasOpenRef.current = true
      previousSelectedHostIdRef.current = selectedHostId
      return
    }
    if (previousSelectedHostIdRef.current === selectedHostId) {
      return
    }
    // Clear host-scoped paths and pending defaults before switching targets can submit them.
    previousSelectedHostIdRef.current = selectedHostId
    onResetHostScopedState()
  }, [isOpen, onResetHostScopedState, selectedHostId])
}
