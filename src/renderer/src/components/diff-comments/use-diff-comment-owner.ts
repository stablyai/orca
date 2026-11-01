import { useCallback, useRef, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import type { DiffCommentOwner } from '@/store/worktree-diff-comments-selector'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import { selectDiffCommentOwner } from '@/store/worktree-diff-comments-selector'

export function useDiffCommentOwner(worktreeId: string | null | undefined) {
  return useAppStore(useShallow((state) => selectDiffCommentOwner(state, worktreeId)))
}

export function useOwnedDiffCommentTarget<T extends object>(owner: DiffCommentOwner | null) {
  const [target, setTarget] = useState<T | null>(null)
  const capturedOwner = useRef(owner)
  const setOwnedTarget = useCallback<Dispatch<SetStateAction<T | null>>>(
    (value) => {
      // Position-only updates keep the owner captured at opening.
      if (value && typeof value !== 'function') {
        capturedOwner.current = owner
      }
      setTarget(value)
    },
    [owner]
  )
  return [target, setOwnedTarget, capturedOwner] as const
}
