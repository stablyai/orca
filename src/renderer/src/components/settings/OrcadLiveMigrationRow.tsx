import type { OrcadLiveMigrationProgress } from '../../../../shared/orcad-live-migration-recovery'
import { translate } from '@/i18n/i18n'
import { Button } from '../ui/button'

export function OrcadLiveMigrationRow({
  entry,
  disabled,
  onContinue,
  onConnect
}: {
  entry: OrcadLiveMigrationProgress
  disabled: boolean
  onContinue: (mode: 'initial' | 'recovery') => void
  onConnect: () => void
}): React.JSX.Element {
  const conflict = entry.profileState === 'conflict'
  const verified = entry.phaseEvidence === 'journal-retained'
  const complete = verified && !conflict && entry.sourceRetirement === 'complete'
  const resumable = !conflict && !complete && (verified || entry.phaseEvidence === 'intent-only')
  return (
    <div className="space-y-2 border-t pt-3">
      <p className="break-all font-mono text-xs">
        {entry.sourceSshTargetId} · {entry.migrationId}
      </p>
      <p className="text-xs text-muted-foreground">
        {complete
          ? translate('orcadMigration.complete', 'Host cutover and source retirement confirmed.')
          : conflict
            ? translate(
                'orcadMigration.conflict',
                'Profile conflict: migration is blocked. Preserve the saved state.'
              )
            : verified
              ? translate(
                  'orcadMigration.recordedPhase',
                  'Recorded phase: {{phase}}. Source retirement is pending.',
                  { phase: entry.phase }
                )
              : entry.phaseEvidence === 'intent-only'
                ? translate(
                    'orcadMigration.intent',
                    'Saved intent only. Continue preparation with the original connected source.'
                  )
                : translate(
                    'orcadMigration.unverifiable',
                    'Migration phase is unverifiable. Continuation is blocked until phase evidence is available.'
                  )}
      </p>
      <p className="text-xs text-muted-foreground">
        {translate(
          'orcadMigration.receipts',
          'Recorded retirement receipts: {{recorded}} / {{total}}',
          entry.receipts
        )}
      </p>
      {complete ? (
        <Button variant="outline" size="sm" disabled={disabled} onClick={onConnect}>
          {translate('orcadMigration.connect', 'Refresh destination catalog')}
        </Button>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={disabled || !resumable}
            onClick={() => onContinue('initial')}
          >
            {translate('orcadMigration.continue', 'Continue with connected original source')}
          </Button>
          {verified ? (
            <Button
              variant="outline"
              size="sm"
              disabled={disabled || !resumable}
              onClick={() => onContinue('recovery')}
            >
              {translate('orcadMigration.recover', 'Recover retirement from saved evidence')}
            </Button>
          ) : null}
        </div>
      )}
      {verified && !complete ? (
        <p className="text-xs text-muted-foreground">
          {translate(
            'orcadMigration.recoveryWarning',
            'Recovery can change destination and source state. It is not a read-only check, and some restart states cannot yet be recovered.'
          )}
        </p>
      ) : null}
    </div>
  )
}
