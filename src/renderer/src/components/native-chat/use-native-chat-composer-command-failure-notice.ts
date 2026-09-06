import { useEffect, type Dispatch, type SetStateAction } from 'react'
import type { NativeChatComposerOmpRpcBinding } from './native-chat-composer-types'

export function useNativeChatComposerCommandFailureNotice(args: {
  /** The pane-owned notice as published by the RPC ownership slice, together
   *  with its attribution. `commandFailureSuperseded` marks a notice describing
   *  a session the pane has already replaced: the store settles that ranking
   *  only between two DURABLE notices, and a live failure raised while this
   *  composer was mounted lives in local state, leaving the durable field
   *  looking free — so the same precedence is finished here. */
  ompRpcChat:
    | Pick<
        NativeChatComposerOmpRpcBinding,
        | 'commandFailureMessage'
        | 'commandFailureSuperseded'
        | 'commandFailureId'
        | 'clearCommandFailure'
      >
    | undefined
  setNotice: Dispatch<SetStateAction<string | null>>
}): void {
  const { setNotice } = args
  const {
    commandFailureMessage: message,
    commandFailureSuperseded: superseded,
    commandFailureId: id,
    clearCommandFailure
  } = args.ompRpcChat ?? {}
  // Keyed on the occurrence, not the wording: two sends failing the same way
  // build the identical string, and keying on that would make the second
  // failure no change at all -- nothing shown, nothing consumed.
  useEffect(() => {
    if (!message || id === null || id === undefined) {
      return
    }
    // Consumed either way: an unread durable notice replays on the next remount.
    setNotice((previous) => (superseded && previous ? previous : message))
    // Named, not blind: a newer failure reported while this effect was pending
    // must not be cleared as though it were the one just consumed.
    clearCommandFailure?.({ id })
  }, [clearCommandFailure, id, message, setNotice, superseded])
}
