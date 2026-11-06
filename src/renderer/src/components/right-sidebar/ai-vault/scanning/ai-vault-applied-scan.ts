import { useCallback, useRef, useState } from 'react'
import type { AiVaultListResult } from '../../../../../../shared/ai-vault/contracts/ai-vault-types'
import { reuseAiVaultListResult } from '../session-list/ai-vault-session-identity'
import type { AiVaultSessionLimit } from '../session-list/ai-vault-session-limit'

// Keep the result paired with the request that produced it through deferred publication.
export type AiVaultAppliedScan = {
  result: AiVaultListResult
  limit: AiVaultSessionLimit
  scopeKey: string
  /** Set for Workspace/Project rows, which hold only that scope and cannot stand in for another. */
  scopeOnlyKey: string | null
}

export function useAppliedAiVaultScan(): {
  scan: AiVaultAppliedScan | null
  applyScan: (
    published: AiVaultListResult,
    limit: AiVaultSessionLimit,
    scopeKey: string,
    scopeOnlyKey: string | null,
    onApplied?: (result: AiVaultListResult) => void
  ) => void
} {
  const [scan, setScan] = useState<AiVaultAppliedScan | null>(null)
  const acceptedScanRef = useRef<AiVaultAppliedScan | null>(null)
  // Preserve identity on unchanged republication so React still bails out.
  const applyScan = useCallback(
    (
      published: AiVaultListResult,
      limit: AiVaultSessionLimit,
      scopeKey: string,
      scopeOnlyKey: string | null,
      onApplied?: (result: AiVaultListResult) => void
    ) => {
      const previous = acceptedScanRef.current
      const result = reuseAiVaultListResult(previous?.result ?? null, published)
      const next =
        previous !== null &&
        previous.result === result &&
        previous.limit === limit &&
        previous.scopeKey === scopeKey
          ? previous
          : { result, limit, scopeKey, scopeOnlyKey }
      acceptedScanRef.current = next
      setScan(next)
      onApplied?.(result)
    },
    []
  )
  return { scan, applyScan }
}
