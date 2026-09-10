import { useCallback, useEffect, useRef } from 'react'

// Async connection steps must stop before sending credentials to a different owner.
export function useDatabaseOperationGuard(identity: string): () => () => boolean {
  const current = useRef(identity)
  const mounted = useRef(true)
  current.current = identity
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  return useCallback(() => () => mounted.current && current.current === identity, [identity])
}

export function assertDatabaseOperationCurrent(isCurrent: () => boolean): void {
  if (!isCurrent()) {
    throw new Error('The database tab or project host changed.')
  }
}
