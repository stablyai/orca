import { useState } from 'react'
import type { GitHubWorkItemDetails } from '../../../../shared/github/work-item-types'

/**
 * Why: invalidation deletes a details entry so exactly one fresh read starts (its generation fence keeps
 * pre-write reads out). Keep showing this key's last payload while that read runs and if it fails, so loaded
 * content and unsent drafts stay mounted; another key never sees it, and a cold load still has none.
 */
export function useRetainedWorkItemDetails(
  key: string | null,
  details: GitHubWorkItemDetails | null
): GitHubWorkItemDetails | null {
  const [retained, setRetained] = useState<{ key: string; details: GitHubWorkItemDetails } | null>(
    null
  )
  if (key && details && (retained?.key !== key || retained.details !== details)) {
    setRetained({ key, details })
  }
  return details ?? (key && retained?.key === key ? retained.details : null)
}
