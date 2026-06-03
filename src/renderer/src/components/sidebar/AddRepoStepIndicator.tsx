import { ArrowLeft } from 'lucide-react'
import type { AddRepoDialogStep } from './add-repo-dialog-types'

type AddRepoStepIndicatorProps = {
  step: AddRepoDialogStep
  isAdding: boolean
  onBack: () => void
}

export function AddRepoStepIndicator({
  step,
  isAdding,
  onBack
}: AddRepoStepIndicatorProps): React.JSX.Element | null {
  const isBackStep = step === 'clone' || step === 'remote' || step === 'create' || step === 'nested'
  if (!isBackStep) {
    return null
  }

  const disabled = step === 'nested' && isAdding

  return (
    <div className="flex min-h-5 items-center -mt-1">
      <button
        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer disabled:cursor-default disabled:opacity-40"
        disabled={disabled}
        onClick={onBack}
      >
        <ArrowLeft className="size-3" />
        Back
      </button>
    </div>
  )
}
