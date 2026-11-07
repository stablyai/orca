import { useCallback, useRef, useState } from 'react'
import type { AiVaultListResult } from '../../../../../../shared/ai-vault/contracts/ai-vault-types'
import { reuseAiVaultListResult } from '../session-list/ai-vault-session-identity'
import type { AiVaultSessionLimit } from '../session-list/ai-vault-session-limit'

// Keep the result paired with the request that produced it through deferred publication.
export type AiVaultAppliedScan = {
  result: AiVaultListResult
  limit: AiVaultSessionLimit
  scopeKey: string
  /** Workspace/Project rows hold only that scope and cannot stand in for another. */
  scopeOnly: boolean
}

export function useAppliedAiVaultScan(): {
  scan: AiVaultAppliedScan | null
  applyScan: (
    published: AiVaultListResult,
    limit: AiVaultSessionLimit,
    scopeKey: string,
    scopeOnly: boolean,
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
      scopeOnly: boolean,
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
          : { result, limit, scopeKey, scopeOnly }
      acceptedScanRef.current = next
      setScan(next)
      onApplied?.(result)
    },
    []
  )
  return { scan, applyScan }
}
