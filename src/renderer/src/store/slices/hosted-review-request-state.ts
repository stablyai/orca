import type { HostedReviewInfo } from '../../../../shared/hosted-review'

export const inflightHostedReviewRequests = new Map<
  string,
  {
    promise: Promise<HostedReviewInfo | null>
    force: boolean
    generation: number
    linkedReviewHintKey: string
  }
>()

export const hostedReviewRequestGenerations = new Map<string, number>()

/** @internal - exposed for leak-regression tests only */
export function _getHostedReviewRequestGenerationCountForTest(): number {
  return hostedReviewRequestGenerations.size
}

/** @internal - exposed for leak-regression tests only */
export function _clearHostedReviewRequestGenerationsForTest(): void {
  hostedReviewRequestGenerations.clear()
}
