import { useEffect, type MutableRefObject } from 'react'

export function useWorktreeContextMenuLifecycle({
  createGroupDialogActiveRef,
  createGroupDialogOpen,
  lifecycleStartedRef,
  menuOpen,
  onLifecycleComplete,
  parentPicker,
  pendingParentPickerRef,
  scheduleDialogOpen
}: {
  createGroupDialogActiveRef: MutableRefObject<boolean>
  createGroupDialogOpen: boolean
  lifecycleStartedRef: MutableRefObject<boolean>
  menuOpen: boolean
  onLifecycleComplete?: () => void
  parentPicker: unknown
  pendingParentPickerRef: MutableRefObject<unknown>
  scheduleDialogOpen: boolean
}): void {
  useEffect(() => {
    if (!onLifecycleComplete) {
      return
    }
    if (menuOpen) {
      lifecycleStartedRef.current = true
    }
    if (
      !lifecycleStartedRef.current ||
      menuOpen ||
      createGroupDialogOpen ||
      scheduleDialogOpen ||
      createGroupDialogActiveRef.current ||
      parentPicker !== null ||
      pendingParentPickerRef.current !== null
    ) {
      return
    }
    const timer = window.setTimeout(() => {
      if (createGroupDialogActiveRef.current || pendingParentPickerRef.current !== null) {
        return
      }
      lifecycleStartedRef.current = false
      onLifecycleComplete?.()
    }, 0)
    return () => window.clearTimeout(timer)
  }, [
    createGroupDialogActiveRef,
    createGroupDialogOpen,
    lifecycleStartedRef,
    menuOpen,
    onLifecycleComplete,
    parentPicker,
    pendingParentPickerRef,
    scheduleDialogOpen
  ])
}
