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

/** Settle when the record stops, not when the host request returns, so unreachable cancellation cannot stall a Create PR click. */
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
    // Stop leaves the request running; requestId/status checks discard late results.
    await Promise.race([request, stoppedRunning])
  } finally {
    unsubscribe()
  }
  const record = useAppStore.getState().pullRequestGenerationRecords[generationKey]
  // Failed/stopped/superseded requests have no result for this run.
  return { result: record?.context.requestId === requestId ? record.result : null }
}
