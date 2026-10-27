import { gitLabJobTraceToLogExcerpt } from './gitlab-job-log-excerpt'
import type { PRCheckDetail, PRCheckRunDetails } from './github/check-types'

export type GitLabJobTraceCheckDetailsStrings = {
  /** Shown for a job with no log: never ran, waiting on a human, or log erased/expired. */
  emptyTrace: string
}

/** Skip never-started queued, manual/neutral and skipped jobs; canceled/erased logs may still 404, which main maps to empty trace. */
export function gitLabJobCanHaveTrace(check: PRCheckDetail): boolean {
  if (check.status === 'queued') {
    return false
  }
  return check.conclusion !== 'neutral' && check.conclusion !== 'skipped'
}

/** Adapt GitLab’s flat trace into one job logTail in the existing provider-neutral check-details shape. */
export function gitLabJobTraceToCheckRunDetails(
  check: PRCheckDetail,
  trace: string,
  strings: GitLabJobTraceCheckDetailsStrings
): PRCheckRunDetails {
  // Older runtimes ignore logExcerpt and return raw traces; bound them again defensively.
  const logTail = gitLabJobTraceToLogExcerpt(trace)
  return {
    name: check.name,
    // Retain row state so status/conclusion cache invalidation does not evict this entry every poll.
    status: check.status,
    conclusion: check.conclusion,
    url: check.url,
    detailsUrl: check.url,
    startedAt: null,
    completedAt: null,
    title: null,
    // Explain missing logs instead of falling back to generic no-inline-details copy.
    summary: logTail ? null : strings.emptyTrace,
    text: null,
    annotations: [],
    jobs: logTail
      ? [
          {
            id: check.gitlabJobId ?? null,
            name: check.name,
            status: check.status,
            conclusion: check.conclusion,
            startedAt: null,
            completedAt: null,
            url: check.url,
            logTail,
            steps: []
          }
        ]
      : []
  }
}
