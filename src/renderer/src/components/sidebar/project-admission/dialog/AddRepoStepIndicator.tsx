import { ArrowLeft } from 'lucide-react'
import type { AddRepoDialogStep } from './add-repo-dialog-types'
import { useTranslate } from '@/i18n/use-translate'

type AddRepoStepIndicatorProps = {
  step: AddRepoDialogStep
  isAdding: boolean
  hideBack?: boolean
  onBack: () => void
}

export function AddRepoStepIndicator({
  step,
  isAdding,
  hideBack = false,
  onBack
}: AddRepoStepIndicatorProps): React.JSX.Element | null {
  const t = useTranslate()
  const showBack =
    !hideBack &&
    (step === 'clone' ||
      step === 'remote' ||
      step === 'server-path' ||
      step === 'create' ||
      step === 'nested')

  if (!showBack) {
    return null
  }

  return (
    <div className="-mt-1 flex min-h-5 items-center">
      <button
        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer disabled:cursor-default disabled:opacity-40"
        disabled={step === 'nested' && isAdding}
        onClick={onBack}
      >
        <ArrowLeft className="size-3" />
        {t('auto.components.sidebar.AddRepoStepIndicator.3bb655c117', 'Back')}
      </button>
    </div>
  )
}
