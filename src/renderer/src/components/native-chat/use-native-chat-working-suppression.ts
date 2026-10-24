import { useEffect, useRef, useState } from 'react'
import { shouldClearNativeChatWorkingSuppression } from './native-chat-working-suppression'

export function useNativeChatWorkingSuppression(liveWorking: boolean, workingEpoch: number | null) {
  const [workingInterrupted, setWorkingInterrupted] = useState(false)
  const previousWorkingEpochRef = useRef<number | null>(null)
  useEffect(() => {
    if (
      shouldClearNativeChatWorkingSuppression({
        working: liveWorking,
        interrupted: workingInterrupted,
        workingEpoch,
        previousWorkingEpoch: previousWorkingEpochRef.current
      })
    ) {
      setWorkingInterrupted(false)
    }
    if (liveWorking && workingEpoch != null) {
      previousWorkingEpochRef.current = workingEpoch
    }
    if (!liveWorking) {
      previousWorkingEpochRef.current = null
    }
  }, [liveWorking, workingInterrupted, workingEpoch])
  return [workingInterrupted, setWorkingInterrupted] as const
}
