import { useCallback, useState } from 'react'
import { shouldClearNativeChatWorkingSuppression } from '../../../../shared/native-chat/native-chat-working-suppression'

export function useNativeChatWorkingSuppression(working: boolean, workingEpoch: number | null) {
  const [held, setHeld] = useState({
    working,
    workingEpoch,
    previousWorkingEpoch: workingEpoch,
    interrupted: false
  })
  const interrupted =
    held.interrupted &&
    !shouldClearNativeChatWorkingSuppression({
      working,
      interrupted: held.interrupted,
      workingEpoch,
      previousWorkingEpoch: held.previousWorkingEpoch
    })
  if (held.working !== working || held.workingEpoch !== workingEpoch) {
    setHeld({
      working,
      workingEpoch,
      previousWorkingEpoch: working ? (workingEpoch ?? held.previousWorkingEpoch) : null,
      interrupted
    })
  }
  const setInterrupted = useCallback((value: boolean) => {
    setHeld((previous) => ({ ...previous, interrupted: value }))
  }, [])
  return [interrupted, setInterrupted] as const
}
