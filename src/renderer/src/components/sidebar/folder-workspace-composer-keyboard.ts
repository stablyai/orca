import { useEffect } from 'react'
import type { RefObject } from 'react'
import { shouldAllowComposerEnterSubmitTarget } from '@/lib/new-workspace-enter-guard'
import { isScreenSubmitShortcut } from '@/lib/screen-submit-shortcut'

type UseFolderWorkspaceComposerKeyboardInput = {
  open: boolean
  submitting: boolean
  composerRef: RefObject<HTMLDivElement | null>
  onOpenChange: (open: boolean) => void
  onCreate: () => void
}

export function useFolderWorkspaceComposerKeyboard({
  open,
  submitting,
  composerRef,
  onOpenChange,
  onCreate
}: UseFolderWorkspaceComposerKeyboardInput): void {
  useEffect(() => {
    if (!open) {
      return
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Enter' && event.key !== 'Escape') {
        return
      }
      const target = event.target
      if (!(target instanceof HTMLElement)) {
        return
      }
      if (event.key === 'Escape') {
        if (
          target instanceof HTMLInputElement ||
          target instanceof HTMLTextAreaElement ||
          target instanceof HTMLSelectElement ||
          target.isContentEditable
        ) {
          event.preventDefault()
          target.blur()
          return
        }
        event.preventDefault()
        onOpenChange(false)
        return
      }
      if (!isScreenSubmitShortcut(event)) {
        return
      }
      if (!shouldAllowComposerEnterSubmitTarget(target, composerRef.current) || submitting) {
        return
      }
      event.preventDefault()
      onCreate()
    }
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [composerRef, onCreate, onOpenChange, open, submitting])
}
