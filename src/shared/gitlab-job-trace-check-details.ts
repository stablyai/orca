import { gitLabJobTraceToLogExcerpt } from './gitlab-job-log-excerpt'
import type { PRCheckDetail, PRCheckRunDetails } from './types'

export type GitLabJobTraceCheckDetailsStrings = {
  /** Shown for a job with no log: never ran, waiting on a human, or log erased/expired. */
  emptyTrace: string
}

/**
 * Whether GitLab can have a trace for this job yet.
 *
 * Jobs that never started (`created`/`pending` -> queued) and jobs waiting on a human
 * (`manual` -> neutral) or bypassed (`skipped`) have no trace, so skip the round trip.
 * Other jobs may still lack a log (canceled before start, erased); main maps that 404
 * to an empty trace rather than an error.
 */
export function gitLabJobCanHaveTrace(check: PRCheckDetail): boolean {
  if (check.status === 'queued') {
    return false
  }
  return check.conclusion !== 'neutral' && check.conclusion !== 'skipped'
}

/**
 * Adapt a GitLab job trace to the provider-neutral check-details shape the Checks
 * panel and the full-details tab already render. GitLab exposes one flat trace per
 * job rather than GitHub's step/annotation breakdown, so it lands in a single job's
 * `logTail`.
 */
export function gitLabJobTraceToCheckRunDetails(
  check: PRCheckDetail,
  trace: string,
  strings: GitLabJobTraceCheckDetailsStrings
): PRCheckRunDetails {
  // Re-slice defensively: an older remote runtime returns the raw trace because it
  // does not understand the `logExcerpt` request flag.
  const logTail = gitLabJobTraceToLogExcerpt(trace)
  return {
    name: check.name,
    // Why: copying the row's own state keeps the panel's status/conclusion cache
    // invalidation from evicting this entry on every poll tick.
    status: check.status,
    conclusion: check.conclusion,
    url: check.url,
    detailsUrl: check.url,
    startedAt: null,
    completedAt: null,
    title: null,
    // Why: a job with no log still needs a distinct explanation, otherwise it falls
    // back to the generic "no inline details" text this feature exists to remove.
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
