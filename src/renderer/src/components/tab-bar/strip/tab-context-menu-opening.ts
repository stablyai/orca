import { useCallback } from 'react'

export function useTabContextMenuOpening(
  onOpenChange: (open: boolean) => void,
  retirePendingActivation: () => void
): (open: boolean) => void {
  return useCallback(
    (open: boolean) => {
      if (open) {
        retirePendingActivation()
      }
      onOpenChange(open)
    },
    [onOpenChange, retirePendingActivation]
  )
}
