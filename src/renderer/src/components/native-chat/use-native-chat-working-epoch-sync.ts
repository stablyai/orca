import { useEffect, type Dispatch, type RefObject, type SetStateAction } from 'react'
import { shouldClearNativeChatWorkingSuppression } from '../../../../shared/native-chat/native-chat-working-suppression'

/** Clears interrupt suppression and tracks the working epoch across turn transitions. */
export function useNativeChatWorkingEpochSync(params: {
  liveWorking: boolean
  workingInterrupted: boolean
  workingEpoch: number | null
  previousWorkingEpochRef: RefObject<number | null>
  setWorkingInterrupted: Dispatch<SetStateAction<boolean>>
}): void {
  const {
    liveWorking,
    workingInterrupted,
    workingEpoch,
    previousWorkingEpochRef,
    setWorkingInterrupted
  } = params
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
