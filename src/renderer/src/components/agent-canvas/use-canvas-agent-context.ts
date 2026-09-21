import { createContext, useCallback, useEffect, useEffectEvent, useSyncExternalStore } from 'react'
import type { CanvasDocument } from './agent-canvas-document'
import type { DashboardCard } from '../../../../shared/dashboard-snapshot'
import {
  EMPTY_CANVAS_CONTEXT,
  readCanvasContext,
  subscribeCanvasContext,
  syncCanvasContext
} from './canvas-context-sync'

export const CanvasContextStatus = createContext(EMPTY_CANVAS_CONTEXT)
export function useCanvasAgentContext(
  scope: string,
  document: CanvasDocument,
  cards: DashboardCard[],
  readOnly = false
) {
  const read = useCallback(() => readCanvasContext(scope), [scope])
  const value = useSyncExternalStore(subscribeCanvasContext, read, () => EMPTY_CANVAS_CONTEXT)
  const refresh = useEffectEvent(() => syncCanvasContext(scope, document, cards, true))
  useEffect(() => {
    if (readOnly) {
      return
    }
    syncCanvasContext(scope, document, cards)
  }, [scope, document, cards, readOnly])
  useEffect(() => {
    if (readOnly) {
      return
    }
    const interval = setInterval(refresh, 5000)
    return () => clearInterval(interval)
  }, [scope, readOnly])
  return value
}
