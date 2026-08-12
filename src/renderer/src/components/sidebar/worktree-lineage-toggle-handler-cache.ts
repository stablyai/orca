import type React from 'react'

export type LineageToggleHandler = (event: React.MouseEvent<HTMLButtonElement>) => void

// Why: WorktreeCard is React.memo'd; an inline arrow per row would give
// onLineageToggle a fresh identity every render and defeat the memo bail-out
// for every lineage-parent card on each sort/status epoch bump. Cache one
// handler per group key (bounded by lineage-group count) so identity is stable.
export const createLineageToggleHandlerCache = (
  toggleGroup: (groupKey: string) => void
): ((groupKey: string) => LineageToggleHandler) => {
  const handlersByGroupKey = new Map<string, LineageToggleHandler>()
  return (groupKey: string) => {
    const cached = handlersByGroupKey.get(groupKey)
    if (cached) {
      return cached
    }
    const handler: LineageToggleHandler = (event) => {
      event.preventDefault()
      event.stopPropagation()
      toggleGroup(groupKey)
    }
    handlersByGroupKey.set(groupKey, handler)
    return handler
  }
}
