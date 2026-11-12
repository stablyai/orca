import { useLayoutEffect, useRef, useState } from 'react'

export function useLocalDiffCommentSession<T extends { dispose(): void }>(
  create: () => T,
  external?: T
): T {
  const [local, setLocal] = useState<T | null>(() => (external ? null : create()))
  let owned = local
  if (!external && !owned) {
    owned = create()
    setLocal(owned)
  }
  const revision = useRef({ value: 0 })
  useLayoutEffect(() => {
    const lifetime = revision.current
    const retained = ++lifetime.value
    return () => {
      // Effect replay reacquires the owner before actual teardown.
      queueMicrotask(() => {
        if (lifetime.value === retained) {
          owned?.dispose()
        }
      })
    }
  }, [owned])
  return external ?? owned!
}
