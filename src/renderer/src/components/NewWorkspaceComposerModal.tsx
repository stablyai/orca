import React, { useCallback, useEffect } from 'react'
import { useAppStore } from '@/store'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import NewWorkspaceComposerCard from '@/components/NewWorkspaceComposerCard'
import { useComposerState } from '@/hooks/useComposerState'
import type { LinkedWorkItemSummary } from '@/lib/new-workspace'

type ComposerModalData = {
  prefilledName?: string
  prefilledPrompt?: string
  initialRepoId?: string
  linkedWorkItem?: LinkedWorkItemSummary | null
}

export default function NewWorkspaceComposerModal(): React.JSX.Element | null {
  const visible = useAppStore((s) => s.activeModal === 'new-workspace-composer')
  const modalData = useAppStore((s) => s.modalData as ComposerModalData | undefined)
  const closeModal = useAppStore((s) => s.closeModal)

  // Why: Dialog open-state transitions must be driven by the store, not a
  // mirror useState, so palette/open-modal calls feel instantaneous and the
  // modal doesn't linger with stale data after close.
  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        closeModal()
      }
    },
    [closeModal]
  )

  if (!visible) {
    return null
  }

  return (
    <ComposerModalBody
      modalData={modalData ?? {}}
      onClose={closeModal}
      onOpenChange={handleOpenChange}
    />
  )
}

function ComposerModalBody({
  modalData,
  onClose,
  onOpenChange
}: {
  modalData: ComposerModalData
  onClose: () => void
  onOpenChange: (open: boolean) => void
}): React.JSX.Element {
  const { cardProps, composerRef, promptTextareaRef, nameInputRef, submit, createDisabled } =
    useComposerState({
      initialName: modalData.prefilledName ?? '',
      initialPrompt: modalData.prefilledPrompt ?? '',
      initialLinkedWorkItem: modalData.linkedWorkItem ?? null,
      initialRepoId: modalData.initialRepoId,
      persistDraft: false,
      onCreated: onClose
    })

  // Autofocus the prompt textarea on open.
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      promptTextareaRef.current?.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [promptTextareaRef])

  // Enter submits, Esc first blurs the focused input (like the full page).
  useEffect(() => {
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
        onClose()
        return
      }

      if (!composerRef.current?.contains(target)) {
        return
      }
      if (createDisabled) {
        return
      }
      if (target instanceof HTMLTextAreaElement && event.shiftKey) {
        return
      }
      event.preventDefault()
      void submit()
    }
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [composerRef, createDisabled, onClose, submit])

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-[calc(100vw-2rem)] border-none bg-transparent p-0 shadow-none sm:max-w-[880px]"
        showCloseButton={false}
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          promptTextareaRef.current?.focus()
        }}
      >
        <NewWorkspaceComposerCard
          containerClassName="bg-card/98 shadow-2xl supports-[backdrop-filter]:bg-card/95"
          composerRef={composerRef}
          nameInputRef={nameInputRef}
          promptTextareaRef={promptTextareaRef}
          {...cardProps}
        />
      </DialogContent>
    </Dialog>
  )
}
