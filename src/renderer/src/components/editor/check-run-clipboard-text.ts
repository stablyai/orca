import type {
  PRCheckAnnotation,
  PRCheckJob,
  PRCheckRunDetails
} from '../../../../shared/github/check-types'

export function formatCheckRunOutputForClipboard(
  details: Pick<PRCheckRunDetails, 'title' | 'summary' | 'text'>
): string {
  return [details.title, details.summary, details.text]
    .filter((value): value is string => Boolean(value))
    .join('\n\n')
}

export function formatAnnotationsForClipboard(
  annotations: PRCheckAnnotation[],
  annotationFallback: string
): string {
  return annotations
    .map((annotation) => {
      const location = `${annotation.path ?? annotationFallback}${
        annotation.startLine ? `:${annotation.startLine}` : ''
      }`
      return [
        location,
        annotation.annotationLevel,
        annotation.title,
        annotation.message,
        annotation.rawDetails
      ]
        .filter((value): value is string => Boolean(value))
        .join('\n')
    })
    .join('\n\n')
}

export function formatJobsForClipboard(jobs: PRCheckJob[], unknownLabel: string): string {
  return jobs
    .map((job) => {
      const steps = job.steps.map(
        (step) => `${step.name}: ${step.conclusion ?? step.status ?? unknownLabel}`
      )
      return [`${job.name}: ${job.conclusion ?? job.status ?? unknownLabel}`, ...steps, job.logTail]
        .filter((value): value is string => Boolean(value))
        .join('\n')
    })
    .join('\n\n')
}
