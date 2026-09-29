import React, { useCallback, useEffect, useRef } from 'react'
import { useAppStore } from '@/store'
import { isImeOwnedKeyboardEvent } from '@/lib/ime-composition-keyboard-event'
import { getWorkspaceComposerInitialFocusTarget } from '@/lib/workspace-composer-initial-focus'
import {
  WorkspaceComposerBody,
  type ComposerModalData
} from '@/components/NewWorkspaceComposerModal'

/**
 * Center-pane host for the prompt-first composer: same state and card as the dialog,
 * laid out like a chat start screen instead of a modal.
 */
export default function NewWorkspaceComposerPane(): React.JSX.Element {
  const modalData = useAppStore((s) => s.modalData as ComposerModalData | undefined)
  const closeModal = useAppStore((s) => s.closeModal)
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const submitCancelledRef = useRef(false)
  const isSubmissionCancelled = useCallback(() => submitCancelledRef.current, [])
  const closeComposer = useCallback(() => {
    if (useAppStore.getState().activeModal === 'new-workspace-composer') {
      closeModal()
    }
  }, [closeModal])
  const dismiss = useCallback(() => {
    submitCancelledRef.current = true
    closeComposer()
  }, [closeComposer])

  useEffect(() => {
    getWorkspaceComposerInitialFocusTarget(containerRef.current ?? document)?.focus({
      preventScroll: true
    })
  }, [])

  // Why: the pane is not modal, so switching workspaces in the sidebar leaves it behind.
  // Leaving the workspace view is handled by the dialog host, which outlives this pane.
  const openedForWorktreeRef = useRef(activeWorktreeId)
  useEffect(() => {
    if (activeWorktreeId !== openedForWorktreeRef.current) {
      dismiss()
    }
  }, [activeWorktreeId, dismiss])

  // Why: no dismissable layer here; nested Radix layers preventDefault Escape before it bubbles,
  // and listening on window (after document) is what lets us see that. Escape typed into the
  // sidebar, or one that cancels an IME composition, must not throw the prompt away.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented || isImeOwnedKeyboardEvent(event)) {
        return
      }
      const target = event.target
      const insidePane = target instanceof Node && containerRef.current?.contains(target) === true
      if (!insidePane && target !== document.body) {
        return
      }
      event.preventDefault()
      dismiss()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [dismiss])

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto scrollbar-sleek">
      <div ref={containerRef} className="mt-auto flex w-full flex-col gap-4 px-8 pb-6 pt-10">
        <WorkspaceComposerBody
          modalData={modalData ?? {}}
          onClose={closeComposer}
          isSubmissionCancelled={isSubmissionCancelled}
          active
          cardContentClassName="-mx-2 px-2 pb-1"
          heading={(title, description) => (
            <div className="space-y-1">
              <h1 className="text-lg font-semibold">{title}</h1>
              <p className="text-sm text-muted-foreground">{description}</p>
            </div>
          )}
        />
      </div>
    </div>
  )
}
