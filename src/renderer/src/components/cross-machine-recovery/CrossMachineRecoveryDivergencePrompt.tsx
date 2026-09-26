import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import type { CrossMachineRecoveryDivergence } from '../../../../shared/cross-machine-recovery-provider-ipc'

const CHOICES: { choice: CrossMachineRecoveryDivergence; key: string; fallback: string }[] = [
  { choice: 'keep-local', key: 'keepLocal', fallback: 'Keep local' },
  { choice: 'replace', key: 'replace', fallback: 'Replace local' },
  { choice: 'fork', key: 'fork', fallback: 'Fork as new session' }
]

/** A divergent local copy is never resolved implicitly; the user re-runs pickup with a choice. */
export function CrossMachineRecoveryDivergencePrompt({
  sessionId,
  disabled,
  onChoose
}: {
  sessionId: string | null
  disabled: boolean
  onChoose: (choice: CrossMachineRecoveryDivergence) => void
}): React.JSX.Element {
  return (
    <div
      className="space-y-2 rounded-md border p-2"
      data-testid="cross-machine-recovery-divergence"
    >
      <p className="text-xs text-muted-foreground" role="alert">
        {translate(
          'components.cross-machine-recovery.divergence.message',
          'This computer has a newer local copy of session {{sessionId}}. Choose how to recover it.',
          { sessionId: sessionId ?? '' }
        )}
      </p>
      <div className="flex flex-wrap gap-2">
        {CHOICES.map(({ choice, key, fallback }) => (
          <Button
            key={choice}
            variant="outline"
            size="sm"
            disabled={disabled}
            onClick={() => onChoose(choice)}
          >
            {translate(`components.cross-machine-recovery.divergence.${key}`, fallback)}
          </Button>
        ))}
      </div>
    </div>
  )
}
