import { useCallback, useRef, useState } from 'react'

/**
 * Wraps an immediate mutation (no undo delay) with loading/error state
 * and optimistic patching. Skips if the same key is already in-flight.
 */
export function useImmediateMutation() {
  const [pendingKeys, setPendingKeys] = useState<Set<string>>(new Set())
  const pendingRef = useRef(pendingKeys)
  pendingRef.current = pendingKeys

  const isPending = useCallback((key: string) => pendingKeys.has(key), [pendingKeys])

  const run = useCallback(
    async <T>(
      key: string,
      opts: {
        mutate: () => Promise<T>
        onOptimistic?: () => void
        onSuccess?: (result: T) => void
        onRevert?: () => void
        onError?: (error: string) => void
      }
    ) => {
      if (pendingRef.current.has(key)) {
        return
      }
      setPendingKeys((prev) => new Set(prev).add(key))
      opts.onOptimistic?.()
      try {
        const result = await opts.mutate()
        const asResult = result as { ok?: boolean; error?: string }
        if (asResult && asResult.ok === false) {
          opts.onRevert?.()
          opts.onError?.(asResult.error ?? 'Update failed')
        } else {
          opts.onSuccess?.(result)
        }
      } catch (err) {
        opts.onRevert?.()
        opts.onError?.(err instanceof Error ? err.message : 'Update failed')
      } finally {
        setPendingKeys((prev) => {
          const next = new Set(prev)
          next.delete(key)
          return next
        })
      }
    },
    []
  )

  return { isPending, run }
}
