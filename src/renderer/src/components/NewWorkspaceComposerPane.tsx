import React, { useCallback, useEffect, useRef, useState } from 'react'
import { MessageSquare } from 'lucide-react'
import { useAppStore } from '@/store'
import { isImeOwnedKeyboardEvent } from '@/lib/ime-composition-keyboard-event'
import { getWorkspaceComposerInitialFocusTarget } from '@/lib/workspace-composer-initial-focus'
import {
  WorkspaceComposerBody,
  type ComposerModalData
} from '@/components/NewWorkspaceComposerModal'

function PaneComposerHeading({
  title,
  description
}: {
  title: string
  description: string
}): React.JSX.Element {
  return (
    // Why: mirrors NativeChatEmptyState so the composer reads as the chat it is about to start.
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
      <div className="flex size-12 items-center justify-center rounded-full bg-accent text-accent-foreground">
        <MessageSquare className="size-6" />
      </div>
      <h1 className="text-sm font-medium text-chat-foreground-strong">{title}</h1>
      <p className="max-w-sm text-balance text-xs text-chat-foreground-faint">{description}</p>
    </div>
  )
}

/** Center-pane host for the prompt-first composer: the dialog's body laid out as a chat start screen. */
export default function NewWorkspaceComposerPane(): React.JSX.Element {
  // Why: while another modal holds the slot, the parked object keeps its identity so the body is not reseeded.
  const slotData = useAppStore((s) =>
    s.activeModal === 'new-workspace-composer' ? s.modalData : s.parkedComposerModalData
  )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the pane only mounts with the composer in the slot or parked, and its openers pass ComposerModalData.
  const modalData = slotData as ComposerModalData | null
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  // Why: the sidebar stays usable, so a re-open (another project's "+") must reseed the body's state.
  const [openedData, setOpenedData] = useState(modalData)
  const [openCount, setOpenCount] = useState(0)
  if (modalData !== openedData) {
    setOpenedData(modalData)
    setOpenCount((count) => count + 1)
  }
  const containerRef = useRef<HTMLDivElement | null>(null)
  const submitCancelledRef = useRef(false)
  const isSubmissionCancelled = useCallback(() => submitCancelledRef.current, [])
  const closeComposer = useAppStore((s) => s.closeWorkspaceComposer)
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
  const openedForWorktreeRef = useRef(activeWorktreeId)
  useEffect(() => {
    if (activeWorktreeId !== openedForWorktreeRef.current) {
      dismiss()
    }
  }, [activeWorktreeId, dismiss])

  // Why: on window so nested Radix layers' handled Escape arrives defaultPrevented; sidebar/IME Escape keeps the prompt.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented || isImeOwnedKeyboardEvent(event)) {
        return
      }
      // Why: the sparse preset editor owns Escape to leave its editing mode, as in the dialog.
      if (containerRef.current?.querySelector('[data-sparse-preset-editor]')) {
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
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-chat-canvas scrollbar-sleek">
      <div
        ref={containerRef}
        className="mx-auto flex w-full max-w-(--chat-content-max-width) flex-1 flex-col px-3 pt-2 pb-4 sm:px-4"
      >
        <WorkspaceComposerBody
          key={openCount}
          modalData={modalData ?? {}}
          onClose={closeComposer}
          isSubmissionCancelled={isSubmissionCancelled}
          active
          cardContentClassName="-mx-2 px-2 pb-1"
          heading={PaneComposerHeading}
        />
      </div>
    </div>
  )
}
