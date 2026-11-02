import type { OpenFile } from '@/store/slices/editor'
import { resolveStepOutcome } from './check-job-step-status'
import { scrollTopCache, setWithLRU } from '@/lib/scroll-cache'
import {
  cancelCheckReadingIntents,
  checkDetailsReadingKey,
  checkJobIdentities,
  checkLogDigest,
  checkReadingLogKey,
  claimCheckReadingIntent
} from './check-details-reading-cache'

type ReadingStore = {
  getState(): { openFiles: OpenFile[] }
  subscribe(callback: () => void): () => void
}
type ReadingWriter = {
  job?: string
  text?: string | null
  start(): void
  retire(): number | undefined
  cancel(): void
}

export type CheckDetailsReadingOwner = ReturnType<typeof createCheckDetailsReadingOwner>

export function createCheckDetailsReadingOwner(
  store: ReadingStore,
  tabId: string,
  scope: string,
  context: string
) {
  const key = checkDetailsReadingKey(tabId, scope, context)
  const writers = new Set<ReadingWriter>()
  const pendingCancellation = new Set<ReadingWriter>()
  const cancelledJobs = new Set<string>()
  let ready = false
  let retired = false
  let cancelledAll = false
  let projectedFiles: OpenFile[] | null = null
  let projectedTab: OpenFile | undefined
  let jobs = new Map<string, string | null>()
  const current = (): boolean => ready && !retired && projectedFiles === store.getState().openFiles
  const matches = (job?: string, text?: string | null): boolean =>
    current() && (job === undefined || (jobs.has(job) && jobs.get(job) === text))
  const retireAll = (): void => {
    retired = true
    for (const writer of writers) {
      writer.retire()
    }
  }
  const project = (): void => {
    const files = store.getState().openFiles
    if (projectedFiles === files || retired) {
      return
    }
    projectedFiles = files
    const tab = files.find((file) => file.id === tabId)
    if (!tab || tab.mode !== 'check-details' || tab.checkRunDetails?.contextKey !== context) {
      retireAll()
      return
    }
    const previous = projectedTab
    projectedTab = tab
    if (
      previous?.checkRunDetails?.details === tab.checkRunDetails.details &&
      previous !== undefined
    ) {
      return
    }
    const entries = checkJobIdentities(tab.checkRunDetails.details?.jobs ?? [])
    const registeredJobs = new Set([...writers].map((writer) => writer.job))
    const nextJobs = new Map(
      entries
        .filter(({ identity }) => registeredJobs.has(identity))
        .map(({ job, identity }) => [identity, job.logTail])
    )
    jobs = nextJobs
    for (const writer of writers) {
      if (
        writer.job === undefined ||
        (nextJobs.has(writer.job) && nextJobs.get(writer.job) === writer.text)
      ) {
        continue
      }
      const value = writer.retire()
      pendingCancellation.delete(writer)
      if (!current() || projectedTab !== tab) {
        return
      }
      if (writer.text) {
        scrollTopCache.delete(checkReadingLogKey(key, writer.job, checkLogDigest(writer.text)))
        if (!current() || projectedTab !== tab) {
          return
        }
        const nextText = nextJobs.get(writer.job)
        if (nextText && value !== undefined) {
          setWithLRU(
            scrollTopCache,
            checkReadingLogKey(key, writer.job, checkLogDigest(nextText)),
            value
          )
        }
      }
    }
  }
  return {
    key,
    current: matches,
    currentSteps: (identity: string, failed: boolean): boolean =>
      current() &&
      checkJobIdentities(projectedTab?.checkRunDetails?.details?.jobs ?? []).some(
        (entry) =>
          entry.identity === identity && (resolveStepOutcome(entry.job) === 'failure') === failed
      ),
    attach(): () => void {
      // Strict Mode creates a new subscription lifetime without reviving closed owners.
      if (retired) {
        return () => {}
      }
      const unsubscribe = store.subscribe(project)
      ready = true
      projectedFiles = null
      project()
      if (current()) {
        for (const writer of writers) {
          writer.start()
        }
      }
      return () => {
        for (const writer of writers) {
          writer.retire()
        }
        ready = false
        unsubscribe()
      }
    },
    register(writer: ReadingWriter): () => void {
      writers.add(writer)
      pendingCancellation.add(writer)
      if (current() && writer.job !== undefined && !jobs.has(writer.job)) {
        const entry = checkJobIdentities(projectedTab?.checkRunDetails?.details?.jobs ?? []).find(
          ({ identity }) => identity === writer.job
        )
        if (entry) {
          jobs.set(entry.identity, entry.job.logTail)
        }
      }
      if (matches(writer.job, writer.text)) {
        writer.start()
      }
      return () => {
        writer.retire()
        writers.delete(writer)
        pendingCancellation.delete(writer)
      }
    },
    claim(job: string): boolean {
      return current() && claimCheckReadingIntent(tabId, context, key, job)
    },
    cancel(job?: string): void {
      if (!current()) {
        return
      }
      if (!cancelledAll && (job === undefined || !cancelledJobs.has(job))) {
        cancelCheckReadingIntents(tabId, context, key, job)
        if (job === undefined) {
          cancelledAll = true
        } else {
          cancelledJobs.add(job)
        }
      }
      for (const writer of pendingCancellation) {
        if (job === undefined || writer.job === job) {
          writer.cancel()
          pendingCancellation.delete(writer)
        }
      }
    }
  }
}
