import { ArrowLeft } from 'lucide-react'
import type { AddRepoDialogStep } from './add-repo-dialog-types'

type AddRepoStepIndicatorProps = {
  step: AddRepoDialogStep
  isInputStep: boolean
  isAdding: boolean
  onBack: () => void
}

export function AddRepoStepIndicator({
  step,
  isInputStep,
  isAdding,
  onBack
}: AddRepoStepIndicatorProps): React.JSX.Element {
  return (
    <div className="flex items-center justify-center -mt-1">
      {(step === 'clone' || step === 'remote' || step === 'create') && (
        <button
          className="absolute left-6 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
          onClick={onBack}
        >
          <ArrowLeft className="size-3" />
          Back
        </button>
      )}
      {step === 'nested' && (
        <button
          className="absolute left-6 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer disabled:cursor-default disabled:opacity-40"
          disabled={isAdding}
          onClick={onBack}
        >
          <ArrowLeft className="size-3" />
          Back
        </button>
      )}
      <div className="flex items-center gap-1.5">
        <div
          className={`size-1.5 rounded-full transition-colors ${isInputStep ? 'bg-foreground' : 'bg-muted-foreground/30'}`}
        />
      </div>
    </div>
  )
}
