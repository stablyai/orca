import type { BrowserScreencastFrameMetadata } from './browser-screencast-protocol'

/**
 * Page scale reported with a screencast frame, or 1 when it is absent or unusable.
 *
 * Why: a mobile page can lay out wider than its viewport and then render at a page scale
 * below 1, so frame pixels and viewport CSS pixels stop agreeing. Input mapping divides by
 * this factor, so a missing, non-finite or non-positive value must fall back to 1 rather
 * than collapse every coordinate.
 */
export function browserScreencastPageScale(
  metadata: Pick<BrowserScreencastFrameMetadata, 'pageScaleFactor'> | null
): number {
  const scale = metadata?.pageScaleFactor
  return typeof scale === 'number' && Number.isFinite(scale) && scale > 0 ? scale : 1
}
