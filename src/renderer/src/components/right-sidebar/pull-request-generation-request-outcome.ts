import { useAppStore } from '@/store'
import type { PullRequestGenerationRecords } from '@/store/slices/pull-request-generation'
import type { PullRequestGenerationOutcome } from './create-pull-request-dialog-field-model'

function isRequestRunning(
  records: PullRequestGenerationRecords,
  generationKey: string,
  requestId: number
): boolean {
  const record = records[generationKey]
  return record?.context.requestId === requestId && record.status === 'running'
}

/**
 * Settles a generation request's outcome once its record stops running rather than when the request
 * returns: Stop cancels the record at once, and a cancel that cannot reach a slow host must not keep
 * the run's caller (a Create PR click) waiting.
 */
export async function settlePullRequestGenerationRequest(
  generationKey: string,
  requestId: number,
  request: Promise<void>
): Promise<PullRequestGenerationOutcome> {
  let unsubscribe = (): void => {}
  const stoppedRunning = new Promise<void>((resolve) => {
    const resolveIfStopped = (records: PullRequestGenerationRecords): void => {
      if (!isRequestRunning(records, generationKey, requestId)) {
        resolve()
      }
    }
    unsubscribe = useAppStore.subscribe((state) =>
      resolveIfStopped(state.pullRequestGenerationRecords)
    )
    resolveIfStopped(useAppStore.getState().pullRequestGenerationRecords)
  })
  try {
    // Why: the request keeps running after Stop; its late result is dropped by the record's requestId and status checks.
    await Promise.race([request, stoppedRunning])
  } finally {
    unsubscribe()
  }
  const record = useAppStore.getState().pullRequestGenerationRecords[generationKey]
  // Why: failed, stopped, or superseded runs carry no result for this request.
  return { result: record?.context.requestId === requestId ? record.result : null }
}
