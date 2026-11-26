import { useTranslate } from '@/i18n/use-translate'

export function PipelineTerminology() {
  const t = useTranslate()
  const terms = [
    [
      t('pipelines.termTemplate', 'Template'),
      t(
        'pipelines.termTemplateMeaning',
        'A reusable description of stages and possible transitions.'
      )
    ],
    [
      t('pipelines.termRun', 'Run'),
      t(
        'pipelines.termRunMeaning',
        'One task being carried out using a fixed version of a template.'
      )
    ],
    [
      t('pipelines.termStage', 'Stage'),
      t('pipelines.termStageMeaning', 'A piece of work assigned to an agent or a set of checks.')
    ],
    [
      t('pipelines.termAttempt', 'Attempt'),
      t(
        'pipelines.termAttemptMeaning',
        'One execution of a stage. A return or retry creates another attempt.'
      )
    ],
    [
      t('pipelines.termResult', 'Result'),
      t(
        'pipelines.termResultMeaning',
        'What the stage submitted: a summary, supporting evidence and any files.'
      )
    ],
    [
      t('pipelines.termDecision', 'Your decision'),
      t(
        'pipelines.termDecisionMeaning',
        'Explicit acceptance, a return for changes or approval of a requested action. A chat message alone is not a decision.'
      )
    ]
  ]
  return (
    <details className="border-t pt-4">
      <summary className="cursor-pointer text-sm font-medium">
        {t('pipelines.terms', 'Pipeline terms')}
      </summary>
      <dl className="mt-4 space-y-3">
        {terms.map(([term, meaning]) => (
          <div key={term}>
            <dt className="text-sm font-semibold">{term}</dt>
            <dd className="mt-1 text-sm text-muted-foreground">{meaning}</dd>
          </div>
        ))}
      </dl>
    </details>
  )
}
