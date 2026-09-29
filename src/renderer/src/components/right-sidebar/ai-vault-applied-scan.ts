import { useCallback, useState } from 'react'
import type { AiVaultListResult } from '../../../../shared/ai-vault-types'
import { applyPublishedAiVaultList } from './ai-vault-session-identity'
import type { AiVaultSessionLimit } from './ai-vault-session-limit'

// One object so a session count is never paired with a depth its scan never ran at.
export type AiVaultAppliedScan = { result: AiVaultListResult; limit: AiVaultSessionLimit }

/** The scan the panel is showing, together with the History depth it ran at. */
export function useAppliedAiVaultScan(): {
  scan: AiVaultAppliedScan | null
  applyScan: (published: AiVaultListResult, limit: AiVaultSessionLimit) => void
} {
  const [scan, setScan] = useState<AiVaultAppliedScan | null>(null)
  // Identity-preserving like the plain setter was, so an unchanged republish still bails out.
  const applyScan = useCallback((published: AiVaultListResult, limit: AiVaultSessionLimit) => {
    applyPublishedAiVaultList(published, (update) =>
      setScan((prev) => {
        const result = update(prev?.result ?? null)
        return prev !== null && prev.result === result && prev.limit === limit
          ? prev
          : { result, limit }
      })
    )
  }, [])
  return { scan, applyScan }
}
