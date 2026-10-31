import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction
} from 'react'

export function useGitHubTaskDeliveryState<T>(
  initial: T[] | (() => T[])
): readonly [T[], Dispatch<SetStateAction<T[]>>] {
  const [delivery, setDelivery] = useState<{ value: T[]; commits: (() => void)[] }>(() => ({
    value: typeof initial === 'function' ? initial() : initial,
    commits: []
  }))
  const acknowledged = useRef<readonly (() => void)[]>([])
  const setValue = useCallback<Dispatch<SetStateAction<T[]>>>((action) => {
    const consumed = new Set(acknowledged.current)
    const receipt = typeof action === 'function' && 'commit' in action ? action.commit : undefined
    setDelivery((current) => ({
      value: typeof action === 'function' ? action(current.value) : action,
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
