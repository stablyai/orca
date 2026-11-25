import { useEffect } from 'react'
import { useAppStore } from '@/store'
import type { FlatEntry } from './use-selection'

/** Share the rows this panel displays so diff-change navigation walks the same list. */
export function useSourceControlVisibleRowsPublish({
  activeWorktreeId,
  visibleSelectionEntries
}: {
  activeWorktreeId: string | null
  visibleSelectionEntries: readonly FlatEntry[]
}): void {
  useEffect(() => {
    if (!activeWorktreeId) {
      return
    }
    const publish = useAppStore.getState().setSourceControlVisibleRows
    publish(activeWorktreeId, visibleSelectionEntries)
    // An unmounted panel owns no rows; a stale list must not keep steering navigation.
    return () => publish(activeWorktreeId, null)
  }, [activeWorktreeId, visibleSelectionEntries])
}
