import type { PRCheckRunDetails } from '../../../shared/github/check-types'
import { sanitizeCheckJobLogExcerpt } from '../../../shared/check-job-log-excerpt'

export function normalizeCheckRunDetailsLogTails(
  details: PRCheckRunDetails | null
): PRCheckRunDetails | null {
  if (!details || !details.jobs.some((job) => typeof job.logTail === 'string')) {
    return details
  }
  return {
    ...details,
    jobs: details.jobs.map((job) =>
      typeof job.logTail === 'string'
        ? { ...job, logTail: sanitizeCheckJobLogExcerpt(job.logTail) }
        : job
    )
  }
}
