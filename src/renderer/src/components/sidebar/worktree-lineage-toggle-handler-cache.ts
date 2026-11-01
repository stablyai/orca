import type React from 'react'

export type LineageToggleHandler = (event: React.MouseEvent<HTMLButtonElement>) => void

// Cache one handler per lineage group so callback identity cannot defeat WorktreeCard memoization.
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
