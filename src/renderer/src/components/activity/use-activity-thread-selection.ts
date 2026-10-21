import { useCallback, useEffect, useMemo, useRef } from 'react'
import type React from 'react'
import { useListMultiSelection } from '@/hooks/use-list-multi-selection'
import type { ActivityVirtualItemDescriptor } from './activity-thread-virtual-items'
import type { AgentPaneThread } from './activity-thread-types'

const getThreadPaneKey = (thread: AgentPaneThread): string => thread.paneKey

export type ActivityThreadClickEvent = Pick<React.MouseEvent, 'metaKey' | 'ctrlKey' | 'shiftKey'>

/** Click/Cmd/Shift multi-select over the agent rows the list renders, in render order. */
export function useActivityThreadSelection({
  virtualItems,
  scrollContainerRef,
  onSelectThread
}: {
  virtualItems: readonly ActivityVirtualItemDescriptor[]
  scrollContainerRef: React.RefObject<HTMLDivElement | null>
  onSelectThread: (thread: AgentPaneThread) => void
}): {
  selectedKeys: ReadonlySet<string>
  handleSelectThread: (thread: AgentPaneThread, event: ActivityThreadClickEvent) => void
  getContextMenuTargets: (thread: AgentPaneThread) => readonly AgentPaneThread[]
} {
  // Collapsed groups contribute no thread items, so their rows drop out of the selection.
  const renderedThreads = useMemo(
    () => virtualItems.flatMap((item) => (item.type === 'thread' ? [item.thread] : [])),
    [virtualItems]
  )
  const getScope = useCallback(() => scrollContainerRef.current, [scrollContainerRef])
  const selection = useListMultiSelection({
    items: renderedThreads,
    getKey: getThreadPaneKey,
    getScope
  })

  // Why a ref: rows are React.memo'd on these handlers, and the selection callbacks change
  // identity with every selection change.
  const selectionRef = useRef(selection)
  const onSelectThreadRef = useRef(onSelectThread)
  useEffect(() => {
    selectionRef.current = selection
    onSelectThreadRef.current = onSelectThread
  }, [selection, onSelectThread])

  const handleSelectThread = useCallback(
    (thread: AgentPaneThread, event: ActivityThreadClickEvent): void => {
      // Why: macOS Ctrl-click is the native secondary click; the row menu handles it.
      if (navigator.userAgent.includes('Mac') && event.ctrlKey && !event.metaKey) {
        return
      }
      if (selectionRef.current.updateSelectionForGesture(event, thread)) {
        return
      }
      onSelectThreadRef.current(thread)
    },
    []
  )
  const getContextMenuTargets = useCallback(
    (thread: AgentPaneThread) => selectionRef.current.selectForContextMenu(thread),
    []
  )

  return { selectedKeys: selection.selectedKeys, handleSelectThread, getContextMenuTargets }
}
