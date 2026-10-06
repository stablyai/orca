import { useCallback, useEffect, useState } from 'react'
import type { AiVaultListResult } from '../../../../shared/ai-vault-types'
import { applyPublishedAiVaultList } from './ai-vault-session-identity'
import type { AiVaultSessionLimit } from './ai-vault-session-limit'
import { useAppStore } from '@/store'
import {
  applyAiVaultTitleChangesSince,
  subscribeAiVaultStructuredTitles
} from './ai-vault-session-result-cache'
import {
  applyAiVaultTitleProjection,
  projectAiVaultStructuredTitles
} from './ai-vault-structured-title-projection'

// One object so a session count is never paired with a depth its scan never ran at.
export type AiVaultAppliedScan = { result: AiVaultListResult; limit: AiVaultSessionLimit }

/** The scan the panel is showing, together with the History depth it ran at. */
export function useAppliedAiVaultScan(): {
  scan: AiVaultAppliedScan | null
  applyScan: (published: AiVaultListResult, limit: AiVaultSessionLimit, cacheKey: string) => void
} {
  const [scan, setScan] = useState<AiVaultAppliedScan | null>(null)
  useEffect(
    () =>
      subscribeAiVaultStructuredTitles((update) => {
        setScan((previous) => {
          if (!previous) {
            return previous
          }
          const result = applyAiVaultTitleProjection(previous.result, update)
          return result === previous.result ? previous : { ...previous, result }
        })
      }),
    []
  )
  // Identity-preserving like the plain setter was, so an unchanged republish still bails out.
  const applyScan = useCallback(
    (published: AiVaultListResult, limit: AiVaultSessionLimit, cacheKey: string) => {
      const current = applyAiVaultTitleChangesSince(published, cacheKey, published)
      const projected = projectAiVaultStructuredTitles(
        current,
        useAppStore.getState().unifiedTabsByWorktree
      )
      applyPublishedAiVaultList(projected, (update) =>
        setScan((prev) => {
          const result = update(prev?.result ?? null)
          return prev !== null && prev.result === result && prev.limit === limit
            ? prev
            : { result, limit }
        })
      )
    },
    []
  )
  return { scan, applyScan }
}
