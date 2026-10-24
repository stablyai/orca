import { useEffect } from 'react'

/** Drop sticky mid-turn queue rank once working and stream preview are both idle. */
export function useClearNativeChatQueuedWhenIdle(
  liveWorking: boolean,
  streamingText: string | null | undefined,
  clearQueued: () => void
): void {
  useEffect(() => {
    if (!liveWorking && !streamingText) {
      clearQueued()
    }
  }, [liveWorking, streamingText, clearQueued])
}
