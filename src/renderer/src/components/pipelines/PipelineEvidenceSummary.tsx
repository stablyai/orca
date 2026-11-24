import type { z } from 'zod'
import type { PipelineV2Evidence } from '../../../../shared/pipelines/v2/pipeline-v2-run-contracts'
import { useTranslate } from '@/i18n/use-translate'

function keyedEvidence<T>(values: T[]) {
  const counts = new Map<string, number>()
  return values.map((value) => {
    const identity = JSON.stringify(value)
    const occurrence = counts.get(identity) ?? 0
    counts.set(identity, occurrence + 1)
    return { value, key: `${identity}:${occurrence}` }
  })
}

export function PipelineEvidenceSummary({
  evidence
}: {
  evidence?: z.infer<typeof PipelineV2Evidence>
}) {
  const t = useTranslate()
  if (!evidence) {
    return null
  }
  if (evidence.stage === 'checks') {
    return (
      <ul className="space-y-1">
        {evidence.results.map((result) => (
          <li key={result.id} className="text-sm">
            {result.id} ·{' '}
            {result.code === 0 && !result.timedOut
              ? t('pipelines.checkPassed', 'Passed')
              : result.timedOut
                ? t('pipelines.checkTimedOut', 'Timed out')
                : result.code === null
                  ? t('pipelines.checkUnknown', 'Result unknown')
                  : t('pipelines.checkFailed', 'Failed')}
            {result.outputTruncated
              ? ` · ${t('pipelines.outputTruncated', 'Output was truncated')}`
              : ''}
          </li>
        ))}
      </ul>
    )
  }
  if (evidence.stage === 'review') {
    return (
      <ul className="space-y-2">
        {evidence.findings.length ? (
          keyedEvidence(evidence.findings).map(({ value: finding, key }) => (
            <li key={key} className="text-sm">
              <span className="font-medium">{finding.severity}</span> · {finding.detail}
              <p className="text-xs text-muted-foreground">
                {finding.conditionToFix}
                {finding.path ? ` · ${finding.path}` : ''}
              </p>
            </li>
          ))
        ) : (
          <li className="text-sm">
            {t('pipelines.noFindings', 'The reviewer reported no findings.')}
          </li>
        )}
      </ul>
    )
  }
  const lines =
    evidence.stage === 'plan'
      ? [...evidence.criteria, ...evidence.steps]
      : 'changes' in evidence
        ? evidence.changes
        : evidence.stage === 'docs'
          ? [...evidence.files, ...(evidence.rationale ? [evidence.rationale] : [])]
          : [evidence.statement, evidence.rationale, ...evidence.files]
  return (
    <ul className="space-y-1">
      {keyedEvidence(lines).map(({ value: line, key }) => (
        <li key={key} className="whitespace-pre-wrap break-words text-sm">
          {line}
        </li>
      ))}
    </ul>
  )
}
