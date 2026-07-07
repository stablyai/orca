import type { PRCheckDetail, PRCheckRunDetails } from './types'

// Why: GitLab job traces can be megabytes; the Checks panel only needs the tail
// to surface the failure, matching the GitHub log-excerpt behavior.
const GITLAB_TRACE_TAIL_LINES = 200

function sliceTraceTail(trace: string): string {
  const lines = trace.split(/\r?\n/)
  if (lines.length <= GITLAB_TRACE_TAIL_LINES) {
    return trace
  }
  return lines.slice(-GITLAB_TRACE_TAIL_LINES).join('\n')
}

/**
 * Adapts a GitLab job trace into the shared `PRCheckRunDetails` shape so the
 * Checks panel and full-details tab can reuse the GitHub rendering path. GitLab
 * exposes a single flat trace per job rather than GitHub's step/annotation
 * breakdown, so the trace lands in one synthetic job's `logTail`.
 */
export function gitLabJobTraceToCheckRunDetails(
  check: PRCheckDetail,
  trace: string
): PRCheckRunDetails {
  const logTail = sliceTraceTail(trace).trim()
  return {
    name: check.name,
    status: check.status,
    conclusion: check.conclusion,
    url: check.url,
    detailsUrl: check.url,
    startedAt: null,
    completedAt: null,
    title: null,
    summary: null,
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
