import { useLayoutEffect, useRef } from 'react'

export function useLocalDiffCommentSession<T extends { dispose(): void }>(
  create: () => T,
  external?: T
): T {
  const owned = useRef<T | null>(null)
  if (!external && !owned.current) {
    owned.current = create()
  }
  const revision = useRef(0)
  const local = owned.current
  useLayoutEffect(() => {
    const retained = ++revision.current
    return () => {
      // Effect replay reacquires the owner before actual teardown.
      queueMicrotask(() => {
        if (revision.current === retained) {
          local?.dispose()
        }
      })
    }
  }, [local])
  return external ?? local!
}
