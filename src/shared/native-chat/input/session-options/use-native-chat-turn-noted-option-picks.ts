import type * as React from 'react'
import type { SessionOptionDescriptor, SessionOptionValue } from '../native-chat-session-options'
import {
  markNativeChatTurnOptionPicks,
  NO_NATIVE_CHAT_TURN_OPTION_PICKS,
  takesNativeChatTurnOptionPick,
  withNativeChatTurnOptionPick,
  type NativeChatTurnOptionPicks
} from './native-chat-turn-option-picks'

/** Takes the caller's React: the phone bundle cannot resolve `react` from shared code. */
export function createNativeChatTurnNotedOptionPicksHook({
  useCallback,
  useMemo,
  useState
}: Pick<typeof React, 'useCallback' | 'useMemo' | 'useState'>) {
  /** Structured lanes send a mid-turn pick at once and the host applies it to the next turn; this only marks it. */
  return function useNativeChatTurnNotedOptionPicks<T>(args: {
    scope: string | null
    isWorking: boolean
    snapshot: SessionOptionDescriptor[]
    setOption: (id: string, value: SessionOptionValue) => Promise<T>
  }): {
    snapshot: SessionOptionDescriptor[]
    setOption: (id: string, value: SessionOptionValue) => Promise<T>
  } {
    const { scope, isWorking, snapshot, setOption } = args
    const [noted, setNoted] = useState<{
      scope: string | null
      picks: NativeChatTurnOptionPicks
    }>({ scope, picks: NO_NATIVE_CHAT_TURN_OPTION_PICKS })
    // An ended turn or another chat starts with nothing noted.
    if ((!isWorking || noted.scope !== scope) && noted.picks.size > 0) {
      setNoted({ scope, picks: NO_NATIVE_CHAT_TURN_OPTION_PICKS })
    }
    const picks =
      isWorking && noted.scope === scope ? noted.picks : NO_NATIVE_CHAT_TURN_OPTION_PICKS
    const notingSetOption = useCallback(
      (id: string, value: SessionOptionValue): Promise<T> => {
        const descriptor = snapshot.find((row) => row.id === id)
        if (isWorking && takesNativeChatTurnOptionPick(descriptor)) {
          setNoted((current) => ({
            scope,
            picks: withNativeChatTurnOptionPick(
              current.scope === scope ? current.picks : NO_NATIVE_CHAT_TURN_OPTION_PICKS,
              descriptor,
              value
            )
          }))
        }
        return setOption(id, value)
      },
      [isWorking, scope, setOption, snapshot]
    )
    const marked = useMemo(
      () => markNativeChatTurnOptionPicks(snapshot, picks, 'noted'),
      [picks, snapshot]
    )
    return { snapshot: marked, setOption: notingSetOption }
  }
}
