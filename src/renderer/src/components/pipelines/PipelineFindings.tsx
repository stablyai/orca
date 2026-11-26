import { useTranslate } from '@/i18n/use-translate'
import type { usePipelineRun } from './use-pipeline-run'
import { PipelineArtifactView } from './PipelineArtifactView'

export function PipelineFindings({ model }: { model: ReturnType<typeof usePipelineRun> }) {
  const t = useTranslate()
  const ledger = model.read?.status.findingLedger
  if (!ledger?.total) {
    return null
  }
  return (
    <section className="space-y-3 rounded-xl border bg-card p-4 text-card-foreground">
      <h2 className="text-base font-semibold">
        {t('pipelines.retainedFindings', 'Review findings across attempts')}
      </h2>
      <p className="text-xs text-muted-foreground">
        {t(
          'pipelines.findingScope',
          'Findings are review evidence. A dispute must cite the task requirement; it becomes acknowledged only through an explicit owner decision.'
        )}
      </p>
      {model.read?.definition.completionPolicy.kind === 'reviewed_source' &&
        model.read.definition.completionPolicy.findingDisputes === 'stage_rationale' && (
          <p className="text-xs text-muted-foreground">
            {t(
              'pipelines.stageDisputeMeaning',
              'The selected policy accepts requirement-citing disputes from accepted stages; owner acknowledgment is shown separately.'
            )}
          </p>
        )}
      <ol className="space-y-3">
        {ledger.findings.map((finding) => (
          <li key={finding.id} className="space-y-1 border-t pt-3">
            <p className="text-sm font-medium">
              {finding.severity}
              {' · '}
              {finding.disposition === 'fixed_verified'
                ? t('pipelines.findingVerified', 'Fixed with current checks and review')
                : finding.disposition === 'disputed'
                  ? t('pipelines.findingDisputed', 'Disputed against task requirements')
                  : t('pipelines.findingOpen', 'Open')}
            </p>
            <p className="whitespace-pre-wrap break-words text-sm">{finding.detail}</p>
            <p className="whitespace-pre-wrap break-words text-xs text-muted-foreground">
              {finding.conditionToFix}
            </p>
            {finding.rationale && (
              <p className="whitespace-pre-wrap break-words text-sm">{finding.rationale}</p>
            )}
            {finding.requirement && (
              <p className="whitespace-pre-wrap break-words text-sm">{finding.requirement}</p>
            )}
            {finding.proposedFixed && (
              <p className="text-xs text-muted-foreground">
                {t(
                  'pipelines.findingFixPending',
                  'Fix reported; current checks and a later accepted review are still required.'
                )}
              </p>
            )}
            {finding.ownerAcknowledged && (
              <p className="text-xs text-muted-foreground">
                {t('pipelines.disputeAcknowledged', 'Owner acknowledged this dispute.')}
              </p>
            )}
            <p className="break-all font-mono text-xs text-muted-foreground">{finding.id}</p>
            <PipelineArtifactView
              scope={model.resource.scope}
              artifactId={finding.candidateId}
              label={t('pipelines.fullFindingEvidence', 'Full finding evidence')}
            />
          </li>
        ))}
      </ol>
      {ledger.omitted > 0 && (
        <p className="text-xs text-muted-foreground">
          {t(
            'pipelines.findingsOmitted',
            '{{omitted}} additional findings remain in stage artifacts. Important unresolved findings: {{count}}.',
            { omitted: ledger.omitted, count: ledger.unresolvedImportant }
          )}
        </p>
      )}
    </section>
  )
}
