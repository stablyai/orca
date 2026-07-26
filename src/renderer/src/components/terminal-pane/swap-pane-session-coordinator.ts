import { create } from 'zustand'

type SwapState = {
  sourceTabId: string | null
  sourceLeafId: string | null
}

export const useSwapState = create<SwapState>(() => ({
  sourceTabId: null,
  sourceLeafId: null
}))

export function getSwapSource(): { tabId: string; leafId: string } | null {
  const { sourceTabId, sourceLeafId } = useSwapState.getState()
  if (sourceTabId && sourceLeafId) {
    return { tabId: sourceTabId, leafId: sourceLeafId }
  }
  return null
}

export function setSwapSource(tabId: string | null, leafId: string | null): void {
  useSwapState.setState({ sourceTabId: tabId, sourceLeafId: leafId })
}
