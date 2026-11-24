import { useEffect } from 'react'
import { useAppStore } from '@/store/index'
import { selectWorkerTabFold } from './worker-tab-folding'

/** Records fail-open shows as sticky and re-evaluates the pane when a fold grace window ends. */
export function useWorkerTabFoldMaintenance(worktreeId: string, groupId: string): void {
  const failOpen = useAppStore((state) => selectWorkerTabFold(state, worktreeId, groupId).failOpen)
  const nextGraceEndsAt = useAppStore(
    (state) => selectWorkerTabFold(state, worktreeId, groupId).nextGraceEndsAt
  )
  useEffect(() => {
    if (failOpen.length) {
      useAppStore.getState().markWorkerTabFailOpenShown(failOpen)
    }
  }, [failOpen])
  useEffect(() => {
    if (nextGraceEndsAt === null) {
      return
    }
    const timer = setTimeout(
      () => useAppStore.getState().bumpWorkerTabGraceEpoch(),
      Math.max(0, nextGraceEndsAt - Date.now()) + 50
    )
    return () => clearTimeout(timer)
  }, [nextGraceEndsAt])
}
