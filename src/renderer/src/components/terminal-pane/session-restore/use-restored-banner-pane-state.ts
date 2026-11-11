import { useState } from 'react'
import type { SessionRestoredBannerReason } from './session-restored-banner-pane-state'

export function useRestoredBannerPaneState() {
  const [sessionRestoredBannerPaneIds, setSessionRestoredBannerPaneIds] = useState<
    Map<number, SessionRestoredBannerReason>
  >(() => new Map())
  return { sessionRestoredBannerPaneIds, setSessionRestoredBannerPaneIds }
}
