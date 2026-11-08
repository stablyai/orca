import { useCallback, useRef, useState } from 'react'
import { useMountedRef } from './useMountedRef'

/** Track loading/errors and optimistic patches for immediate mutations; deduplicate keys already in flight. */
export function useImmediateMutation() {
  const [pendingKeys, setPendingKeys] = useState<Set<string>>(new Set())
  const pendingRef = useRef(pendingKeys)
  const mountedRef = useMountedRef()
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
        formatError?: (result: { error?: unknown; errorCode?: unknown }) => string
      }
    ) => {
      if (pendingRef.current.has(key)) {
        return
      }
      setPendingKeys((prev) => new Set(prev).add(key))
      opts.onOptimistic?.()
      try {
        const result = await opts.mutate()
        if (result && typeof result === 'object' && 'ok' in result && result.ok === false) {
          const error = 'error' in result && typeof result.error === 'string' ? result.error : ''
          const errorCode = 'errorCode' in result ? result.errorCode : undefined
          opts.onRevert?.()
          opts.onError?.(opts.formatError?.({ error, errorCode }) || error || 'Update failed')
        } else {
          opts.onSuccess?.(result)
        }
      } catch (err) {
        opts.onRevert?.()
        opts.onError?.(err instanceof Error ? err.message : 'Update failed')
      } finally {
        if (mountedRef.current) {
          setPendingKeys((prev) => {
            const next = new Set(prev)
            next.delete(key)
            return next
          })
        }
      }
    },
    [mountedRef]
  )

  return { isPending, run }
}
