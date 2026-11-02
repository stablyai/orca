import { useCallback, useRef, useState } from 'react'
import type { AiVaultListResult } from '../../../../shared/ai-vault-types'
import { reuseAiVaultListResult } from './ai-vault-session-identity'
import type { AiVaultSessionLimit } from './ai-vault-session-limit'

// One object so a session count is never paired with a depth its scan never ran at.
export type AiVaultAppliedScan = { result: AiVaultListResult; limit: AiVaultSessionLimit }

/** The scan the panel is showing, together with the History depth it ran at. */
export function useAppliedAiVaultScan(): {
  scan: AiVaultAppliedScan | null
  applyScan: (
    published: AiVaultListResult,
    limit: AiVaultSessionLimit,
    onApplied?: (result: AiVaultListResult) => void
  ) => void
} {
  const [scan, setScan] = useState<AiVaultAppliedScan | null>(null)
  const acceptedScanRef = useRef<AiVaultAppliedScan | null>(null)
  // Identity-preserving like the plain setter was, so an unchanged republish still bails out.
  const applyScan = useCallback(
    (
      published: AiVaultListResult,
      limit: AiVaultSessionLimit,
      onApplied?: (result: AiVaultListResult) => void
    ) => {
      const previous = acceptedScanRef.current
      const result = reuseAiVaultListResult(previous?.result ?? null, published)
      const next =
        previous !== null && previous.result === result && previous.limit === limit
          ? previous
          : { result, limit }
      acceptedScanRef.current = next
      setScan(next)
      onApplied?.(result)
    },
    []
  )
  return { scan, applyScan }
}
