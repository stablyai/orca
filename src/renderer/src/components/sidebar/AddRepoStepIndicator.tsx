import { ArrowLeft } from 'lucide-react'
import type { AddRepoDialogStep } from './add-repo-dialog-types'

type AddRepoStepIndicatorProps = {
  step: AddRepoDialogStep
  isAdding: boolean
  onBack: () => void
  onSetupBack: () => void
}

export function AddRepoStepIndicator({
  step,
  isAdding,
  onBack,
  onSetupBack
}: AddRepoStepIndicatorProps): React.JSX.Element | null {
  const isBackStep = step === 'clone' || step === 'remote' || step === 'create' || step === 'nested'
  const isSetupStep = step === 'setup'
  if (!isBackStep && !isSetupStep) {
    return null
  }

  const disabled = step === 'nested' && isAdding
  const label = isSetupStep ? 'Add another project' : 'Back'

  return (
    <div className="flex min-h-5 items-center -mt-1">
      <button
        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer disabled:cursor-default disabled:opacity-40"
        disabled={disabled}
        onClick={isSetupStep ? onSetupBack : onBack}
      >
        <ArrowLeft className="size-3" />
        {label}
      </button>
    </div>
  )
}
