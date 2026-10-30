import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction
} from 'react'

export function useGitHubTaskDeliveryState<T>(
  initial: T | (() => T)
): readonly [T, Dispatch<SetStateAction<T>>] {
  // SAFETY: only the lazy-initializer alternative is invoked, matching useState.
  const [delivery, setDelivery] = useState(() => ({
    value: typeof initial === 'function' ? (initial as () => T)() : initial,
    commits: [] as (() => void)[]
  }))
  const acknowledged = useRef<readonly (() => void)[]>([])
  const setValue = useCallback<Dispatch<SetStateAction<T>>>((action) => {
    const consumed = new Set(acknowledged.current)
    const receipt = typeof action === 'function' && 'commit' in action ? action.commit : undefined
    setDelivery((current) => ({
      // SAFETY: React's SetStateAction function alternative has this exact signature.
      value: typeof action === 'function' ? (action as (current: T) => T)(current.value) : action,
      commits: [
        ...current.commits.filter((commit) => !consumed.has(commit)),
        ...(typeof receipt === 'function' ? [() => receipt()] : [])
      ]
    }))
  }, [])
  useLayoutEffect(() => {
    acknowledged.current = delivery.commits
    for (const commit of delivery.commits) {
      commit()
    }
  }, [delivery])
  return [delivery.value, setValue]
}
