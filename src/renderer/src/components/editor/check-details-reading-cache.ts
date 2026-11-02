import type { PRCheckJob, PRCheckRunDetails } from '../../../../shared/github/check-types'
import type { OpenCheckRunDetailsState } from '../../../../shared/editor-tab-view-types'
import { scrollTopCache, setWithLRU } from '@/lib/scroll-cache'
import { sha256 } from '@/lib/sha256'
import { resolveStepOutcome } from './check-job-step-status'

export function checkJobIdentities(
  jobs: readonly PRCheckJob[]
): { job: PRCheckJob; identity: string }[] {
  const occurrences = new Map<string, number>()
  return jobs.map((job) => {
    const identity =
      job.id !== null
        ? JSON.stringify(['id', job.id])
        : job.url
          ? JSON.stringify(['url', job.url])
          : JSON.stringify(['name', job.name, occurrences.get(job.name) ?? 0])
    occurrences.set(job.name, (occurrences.get(job.name) ?? 0) + 1)
    return { job, identity }
  })
}

export function checkLogDigest(text: string): string {
  return Array.from(sha256(new TextEncoder().encode(text)), (byte) =>
    byte.toString(16).padStart(2, '0')
  ).join('')
}

export function checkDetailsReadingKey(
  tabId: string,
  scope: string | null,
  context: string
): string {
  return `${tabId}::check-details::${JSON.stringify([scope, context])}`
}

export const checkReadingOuterKey = (owner: string): string => `${owner}::outer`
export const checkReadingIntentKey = (owner: string, job: string): string =>
  `${owner}::intent:${encodeURIComponent(job)}`
export const checkReadingLogKey = (owner: string, job: string, digest: string): string =>
  `${owner}::log:${encodeURIComponent(job)}:${digest}`
export const checkReadingStepsKey = (owner: string, job: string, failed: boolean): string =>
  `${owner}::steps:${encodeURIComponent(job)}:${failed}`
const firstPayloadKey = (owner: string): string => `${owner}::first-payload`

function cacheOwner(key: string, tabId: string, context: string): string | null {
  const prefix = `${tabId}::check-details::`
  if (!key.startsWith(prefix)) {
    return null
  }
  const owner = key.slice(0, key.lastIndexOf('::'))
  try {
    const parts: unknown = JSON.parse(owner.slice(prefix.length))
    return Array.isArray(parts) && parts.length === 2 && parts[1] === context ? owner : null
  } catch {
    return null
  }
}

export function cancelCheckReadingIntents(
  tabId: string,
  context: string,
  pane: string,
  job?: string
): void {
  const unclaimed = checkDetailsReadingKey(tabId, null, context)
  for (const owner of [pane, unclaimed]) {
    if (job !== undefined) {
      scrollTopCache.delete(checkReadingIntentKey(owner, job))
    } else {
      for (const key of scrollTopCache.keys()) {
        if (key === firstPayloadKey(owner) || key.startsWith(`${owner}::intent:`)) {
          scrollTopCache.delete(key)
        }
      }
    }
  }
}

export function claimCheckReadingIntent(
  tabId: string,
  context: string,
  owner: string,
  job: string
): boolean {
  const local = checkReadingIntentKey(owner, job)
  if (scrollTopCache.get(local) === -1) {
    return true
  }
  const unclaimed = checkReadingIntentKey(checkDetailsReadingKey(tabId, null, context), job)
  if (scrollTopCache.get(unclaimed) !== -1) {
    return false
  }
  scrollTopCache.delete(unclaimed)
  setWithLRU(scrollTopCache, local, -1)
  return true
}

function seedJobs(owner: string, details: PRCheckRunDetails, isCurrent: () => boolean): void {
  for (const { identity } of checkJobIdentities(details.jobs)
    .filter(
      ({ job }) =>
        resolveStepOutcome(job) === 'failure' && (Boolean(job.logTail) || job.logState === 'error')
    )
    .slice(0, 5)) {
    if (!isCurrent()) {
      return
    }
    setWithLRU(scrollTopCache, checkReadingIntentKey(owner, identity), -1)
  }
}

export function reconcileCheckDetailsReadingCache(
  tabId: string,
  previous: OpenCheckRunDetailsState | undefined,
  next: OpenCheckRunDetailsState,
  isCurrent: () => boolean
): void {
  if (!isCurrent()) {
    return
  }
  const context = next.contextKey
  const unclaimed = checkDetailsReadingKey(tabId, null, context)
  if (!previous || previous.contextKey !== context) {
    const owners = [...scrollTopCache.keys()]
      .filter((key) => !previous || cacheOwner(key, tabId, previous.contextKey))
      .filter((key) => key.startsWith(`${tabId}::check-details::`))
    for (const key of owners) {
      if (!isCurrent()) {
        return
      }
      scrollTopCache.delete(key)
    }
    if (!isCurrent()) {
      return
    }
    if (next.details) {
      seedJobs(unclaimed, next.details, isCurrent)
    } else {
      setWithLRU(scrollTopCache, firstPayloadKey(unclaimed), -1)
    }
    return
  }
  if (previous.details === next.details || !next.details) {
    return
  }
  if (scrollTopCache.get(firstPayloadKey(unclaimed)) === -1) {
    scrollTopCache.delete(firstPayloadKey(unclaimed))
    if (isCurrent()) {
      seedJobs(unclaimed, next.details, isCurrent)
    }
  }
  const nextJobs = new Map(
    checkJobIdentities(next.details.jobs).map(({ job, identity }) => [identity, job])
  )
  for (const { job, identity } of checkJobIdentities(previous.details?.jobs ?? [])) {
    const nextJob = nextJobs.get(identity)
    const text = nextJob?.logTail
    if (!text && (job.logTail || job.logState === 'error') && nextJob?.logState !== 'error') {
      const intentSuffix = `::intent:${encodeURIComponent(identity)}`
      for (const key of scrollTopCache.keys()) {
        if (!isCurrent()) {
          return
        }
        if (key.endsWith(intentSuffix) && cacheOwner(key, tabId, context)) {
          scrollTopCache.delete(key)
        }
      }
    }
    if (!job.logTail || job.logTail === text) {
      continue
    }
    const oldSuffix = `::log:${encodeURIComponent(identity)}:${checkLogDigest(job.logTail)}`
    const digest = text ? checkLogDigest(text) : null
    const entries = [...scrollTopCache]
    for (const [key, value] of entries) {
      if (!isCurrent()) {
        return
      }
      const owner = cacheOwner(key, tabId, context)
      if (!owner || !key.endsWith(oldSuffix)) {
        continue
      }
      scrollTopCache.delete(key)
      const destination = digest ? checkReadingLogKey(owner, identity, digest) : null
      if (isCurrent() && destination && !scrollTopCache.has(destination)) {
        setWithLRU(scrollTopCache, destination, value)
      }
    }
  }
}
