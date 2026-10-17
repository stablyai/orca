import { useEffect, type Dispatch, type RefObject, type SetStateAction } from 'react'
import { shouldClearNativeChatWorkingSuppression } from './native-chat-working-suppression'

/** Clears interrupt suppression and tracks the working epoch across turn transitions. */
export function useNativeChatWorkingEpochSync(params: {
  liveWorking: boolean
  workingInterrupted: boolean
  hookWorkingEpoch: number | null
  previousWorkingEpochRef: RefObject<number | null>
  setWorkingInterrupted: Dispatch<SetStateAction<boolean>>
}): void {
  const {
    liveWorking,
    workingInterrupted,
    hookWorkingEpoch,
    previousWorkingEpochRef,
    setWorkingInterrupted
  } = params
  useEffect(() => {
    if (
      shouldClearNativeChatWorkingSuppression({
        working: liveWorking,
        interrupted: workingInterrupted,
        workingEpoch: hookWorkingEpoch,
        previousWorkingEpoch: previousWorkingEpochRef.current
      })
    ) {
      setWorkingInterrupted(false)
    }
    if (liveWorking && hookWorkingEpoch != null) {
      previousWorkingEpochRef.current = hookWorkingEpoch
    }
    if (!liveWorking) {
      previousWorkingEpochRef.current = null
    }
  }, [
    liveWorking,
    workingInterrupted,
    hookWorkingEpoch,
    previousWorkingEpochRef,
    setWorkingInterrupted
  ])
}
