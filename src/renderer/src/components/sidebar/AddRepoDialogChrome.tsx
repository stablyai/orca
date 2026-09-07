import type { ReactNode } from 'react'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import type { AddRepoDialogStep } from './add-repo-dialog-types'
import { AddRepoStepIndicator } from './AddRepoStepIndicator'

export function AddRepoDialogChrome({
  children,
  isAdding,
  isOpen,
  onBack,
  onCloseAutoFocus,
  onOpenChange,
  step
}: {
  children: ReactNode
  isAdding: boolean
  isOpen: boolean
  onBack: () => void
  onCloseAutoFocus?: (event: Event) => void
  onOpenChange: (open: boolean) => void
  step: AddRepoDialogStep
}) {
  return (
    <Dialog open={isOpen} onOpenChange={onOpenChange}>
      <DialogContent
        onCloseAutoFocus={onCloseAutoFocus}
        className={`min-w-0 overflow-hidden sm:max-w-lg [&>*]:min-w-0 ${
          step === 'nested' ? 'max-h-[calc(100vh-2rem)] grid-rows-[auto_auto_minmax(0,1fr)]' : ''
        }`}
      >
        <AddRepoStepIndicator step={step} isAdding={isAdding} onBack={onBack} />
        {children}
      </DialogContent>
    </Dialog>
  )
}
