import { useCallback, useEffect, type Dispatch, type SetStateAction, type RefObject } from 'react'
import { useAppStore } from '@/store'
import type { SourceControlActionError } from '../sync/action-error'

export function useBranchSwitchOutcome(
  setErrors: Dispatch<SetStateAction<Record<string, SourceControlActionError | null>>>,
  sequences: RefObject<Record<string, number>>
) {
  useEffect(
    () =>
      useAppStore.subscribe((state, previous) => {
        if (state.gitStatusByWorktree === previous.gitStatusByWorktree) {
          return
        }
        setErrors((errors) => {
          let next = errors
          for (const [id, error] of Object.entries(errors)) {
            if (
              error?.kind === 'switch_branch' &&
              state.gitStatusByWorktree[id] !== previous.gitStatusByWorktree[id] &&
              state.gitStatusByWorktree[id]?.length === 0 &&
              !state.gitStatusReadErrorByWorktree[id]
            ) {
              next = { ...next, [id]: null }
            }
          }
          return next
        })
      }),
    [setErrors]
  )
  return useCallback(
    (id: string, message?: string, refresh?: () => Promise<void>) => {
      const sequence = (sequences.current[id] ?? 0) + 1
      sequences.current[id] = sequence
      setErrors((previous) => ({
        ...previous,
        [id]: message ? { kind: 'switch_branch', message, rawError: message, sequence } : null
      }))
      // A clean read can reuse the store's entries array, so also settle after the explicit refresh.
      if (refresh) {
        void refresh().then(
          () => {
            const state = useAppStore.getState()
            if (
              state.gitStatusByWorktree[id]?.length === 0 &&
              !state.gitStatusReadErrorByWorktree[id]
            ) {
              setErrors((previous) =>
                previous[id]?.kind === 'switch_branch' && previous[id]?.sequence === sequence
                  ? { ...previous, [id]: null }
                  : previous
              )
            }
          },
          () => {}
        )
      }
    },
    [setErrors, sequences]
  )
}
