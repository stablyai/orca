import { useEffect, useRef } from 'react'

export function useAddRepoHostChangeReset({
  isOpen,
  selectedHostId,
  onResetClosed,
  onResetHostScopedState
}: {
  isOpen: boolean
  selectedHostId: string
  onResetClosed: () => void
  onResetHostScopedState: () => void
}) {
  const previousSelectedHostIdRef = useRef(selectedHostId)

  useEffect(() => {
    if (!isOpen) {
      previousSelectedHostIdRef.current = selectedHostId
      onResetClosed()
    }
  }, [isOpen, onResetClosed, selectedHostId])

  useEffect(() => {
    if (!isOpen || previousSelectedHostIdRef.current === selectedHostId) {
      return
    }
    // Why: Add Project form fields are host-path scoped, so switching hosts must
    // clear typed paths and pending defaults before they can be submitted.
    previousSelectedHostIdRef.current = selectedHostId
    onResetHostScopedState()
  }, [isOpen, onResetHostScopedState, selectedHostId])
}
