import { useEffect, useRef } from 'react'

export function useSshAddTargetIntent(
  addTargetIntentSignal: number | undefined,
  openAddTargetForm: () => void
): void {
  const consumedAddTargetIntentSignalRef = useRef(0)

  useEffect(() => {
    if (
      !addTargetIntentSignal ||
      consumedAddTargetIntentSignalRef.current === addTargetIntentSignal
    ) {
      return
    }
    consumedAddTargetIntentSignalRef.current = addTargetIntentSignal
    openAddTargetForm()
  }, [addTargetIntentSignal, openAddTargetForm])
}
