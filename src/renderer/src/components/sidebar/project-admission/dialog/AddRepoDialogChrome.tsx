import type { ReactNode } from 'react'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { preventOutsideDismissWhenDirty } from '@/lib/overlay-interaction/outside-dismiss-guard'
import type { AddRepoDialogStep } from './add-repo-dialog-types'
import { AddRepoStepIndicator } from './AddRepoStepIndicator'

export function AddRepoDialogChrome({
  children,
  hideBack = false,
  isAdding,
  isCloning,
  isOpen,
  onBack,
  onCloseAutoFocus,
  onOpenChange,
  step
}: {
  children: ReactNode
  hideBack?: boolean
  isAdding: boolean
  isCloning: boolean
  isOpen: boolean
  onBack: () => void
  onCloseAutoFocus?: (event: Event) => void
  onOpenChange: (open: boolean) => void
  step: AddRepoDialogStep
}) {
  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent
        // Radix calls this once the dialog's trap is live, so focusing Browse here cannot bounce through a parent dialog.
        onOpenAutoFocus={(event) => {
          const initialAction =
            event.currentTarget instanceof Element
              ? event.currentTarget.querySelector<HTMLElement>(
                  '[data-add-repo-initial-focus]:not(:disabled)'
                )
              : null
          if (initialAction) {
            event.preventDefault()
            initialAction.focus()
          }
        }}
        onCloseAutoFocus={onCloseAutoFocus}
        // Closing the dialog aborts the clone; require an explicit close while it runs.
        onInteractOutside={preventOutsideDismissWhenDirty(() => isCloning)}
        className={`min-w-0 overflow-hidden sm:max-w-lg [&>*]:min-w-0 ${
          step === 'nested' ? 'max-h-[calc(100vh-2rem)] grid-rows-[auto_auto_minmax(0,1fr)]' : ''
        }`}
      >
        <AddRepoStepIndicator step={step} isAdding={isAdding} hideBack={hideBack} onBack={onBack} />
        {children}
      </DialogContent>
    </Dialog>
  )
}
