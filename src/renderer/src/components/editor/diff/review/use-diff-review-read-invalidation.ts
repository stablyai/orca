import { useEffect, useRef } from 'react'
import { setDiffReviewed, type ReviewedDiff } from '@/lib/editor/diff-reviewed-files'

// Cleared marks must survive an older cached read on either diff surface,
// so both the individual diff and combined sections share invalidation here.
export function useDiffReviewReadInvalidation({
  key,
  record,
  signature,
  entrySignature,
  modifiedTime,
  valid
}: {
  key: string | null
  record: ReviewedDiff | undefined
  signature: string | null
  entrySignature?: string
  modifiedTime?: number | null
  valid: boolean
}): void {
  const previousRead = useRef({ signature, modifiedTime })
  useEffect(() => {
    if (!valid) {
      return
    }
    const changed =
      previousRead.current.signature !== signature ||
      previousRead.current.modifiedTime !== modifiedTime
    previousRead.current = { signature, modifiedTime }
    if (!changed) {
      return
    }
    if (
      key &&
      record &&
      valid &&
      ((entrySignature !== undefined && record.entrySignature !== entrySignature) ||
        (signature !== null && record.contentSignature !== signature) ||
        (modifiedTime !== undefined && record.modifiedTime !== modifiedTime))
    ) {
      setDiffReviewed(key, null)
    }
  }, [key, record, signature, entrySignature, modifiedTime, valid])
}
