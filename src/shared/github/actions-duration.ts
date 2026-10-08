import type { PRCheckRunDetails } from './check-types'
/** Return elapsed seconds only for valid, ordered timestamps; missing or invalid timing remains unknown. */
export function completedDurationSeconds(
  startedAt: string | null,
  completedAt: string | null
): number | null {
  if (!startedAt || !completedAt) {
    return null
  }
  const duration = (Date.parse(completedAt) - Date.parse(startedAt)) / 1000
  return Number.isFinite(duration) && duration >= 0 ? duration : null
}
/** Expose run duration only after every job page is available for a completed attempt. */
export function actionsDurationSeconds(
  details: PRCheckRunDetails | null | undefined
): number | null {
  const metadata = details?.actions
  if (
    !metadata ||
    !details ||
    metadata.run.status !== 'completed' ||
    metadata.jobsError ||
    metadata.hasNextPage ||
    metadata.limitReached ||
    metadata.totalJobs === null ||
    metadata.totalJobs > details.jobs.length
  ) {
    return null
  }
  const completed = details.jobs
    .flatMap((job) => (job.completedAt ? [Date.parse(job.completedAt)] : []))
    .filter(Number.isFinite)
  return completed.length
    ? completedDurationSeconds(
        metadata.run.runStartedAt,
        new Date(Math.max(...completed)).toISOString()
      )
    : null
}
