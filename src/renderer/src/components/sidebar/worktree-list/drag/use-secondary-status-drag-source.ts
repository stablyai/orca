import { useCallback, useState } from 'react'
import {
  getSecondaryStatusDragSourceGroupKey,
  type SecondaryStatusDragSourceArgs
} from './secondary-status-drag-source'

type SecondaryStatusDragSourceInputs = Omit<
  SecondaryStatusDragSourceArgs,
  'sourceGroupKey' | 'draggingWorktreeId'
>

type WorktreeDragSource = {
  sourceGroupKey: string
  draggingWorktreeId: string | null
}

export function useSecondaryStatusDragSource(inputs: SecondaryStatusDragSourceInputs): {
  emptySecondaryStatusSourceGroupKey: string | null
  onWorktreeDragSourceChange: (
    sourceGroupKey: string | null,
    draggingWorktreeId: string | null
  ) => void
} {
  const [dragSource, setDragSource] = useState<WorktreeDragSource | null>(null)
  const emptySecondaryStatusSourceGroupKey = getSecondaryStatusDragSourceGroupKey({
    ...inputs,
    sourceGroupKey: dragSource?.sourceGroupKey ?? null,
    draggingWorktreeId: dragSource?.draggingWorktreeId ?? null
  })
  const onWorktreeDragSourceChange = useCallback(
    (sourceGroupKey: string | null, draggingWorktreeId: string | null) => {
      setDragSource(sourceGroupKey ? { sourceGroupKey, draggingWorktreeId } : null)
    },
    []
  )

  return { emptySecondaryStatusSourceGroupKey, onWorktreeDragSourceChange }
}
