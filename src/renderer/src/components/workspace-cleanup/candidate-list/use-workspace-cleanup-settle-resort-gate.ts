import { useCallback, useEffect, useRef } from 'react'
import { listenForWorkspaceCleanupListInput } from './workspace-cleanup-list-input'

/** Re-sorting at settle is safe only while nothing is selected and the user has not touched the list. */
export function useWorkspaceCleanupSettleResortGate({
  open,
  selectedIds,
  rowsScrollElement
}: {
  open: boolean
  selectedIds: ReadonlySet<string>
  rowsScrollElement: HTMLElement | null
}): () => boolean {
  const selectedIdsRef = useRef(selectedIds)
  useEffect(() => {
    selectedIdsRef.current = selectedIds
  }, [selectedIds])
  // Held order must never wait on the user's first touch, so interaction is tracked in a ref.
  const listInteractedRef = useRef(false)
  useEffect(() => {
    if (open) {
      listInteractedRef.current = false
    }
  }, [open])
  useEffect(() => {
    // Programmatic scrolls must not count as interaction.
    const target = rowsScrollElement?.parentElement ?? rowsScrollElement
    if (!target) {
      return undefined
    }
    return listenForWorkspaceCleanupListInput(target, () => {
      listInteractedRef.current = true
    })
  }, [rowsScrollElement])
  return useCallback(() => selectedIdsRef.current.size === 0 && !listInteractedRef.current, [])
}
