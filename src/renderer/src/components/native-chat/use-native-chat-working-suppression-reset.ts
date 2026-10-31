import { useEffect } from 'react'
import { shouldClearNativeChatWorkingSuppression } from '../../../../shared/native-chat/native-chat-working-suppression'

export function useNativeChatWorkingSuppressionReset(
  liveWorking: boolean,
  workingInterrupted: boolean,
  workingEpoch: number | null,
  previousWorkingEpochRef: { current: number | null },
  setWorkingInterrupted: (value: boolean) => void
): void {
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
  }, [
    liveWorking,
    workingInterrupted,
    workingEpoch,
    previousWorkingEpochRef,
    setWorkingInterrupted
  ])
}
