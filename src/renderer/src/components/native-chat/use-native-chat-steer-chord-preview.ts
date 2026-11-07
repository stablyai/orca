import type { RefObject } from 'react'
import type { NativeChatFollowUpBehavior } from '../../../../shared/native-chat/input/native-chat-follow-up-behavior'
import { useNativeChatSteerChordPreview as useSteerChordPreview } from '../../../../shared/native-chat/input/use-native-chat-steer-chord-preview'
import type { NativeChatComposerSendIntent } from './native-chat-composer-types'
import { isMacPlatform } from './native-chat-shortcut'

/** Desktop's chord: Cmd+Enter on a Mac, Ctrl+Enter elsewhere. */
export function useNativeChatSteerChordPreview(
  root: RefObject<HTMLElement | null>,
  sendState: {
    alternateSend?: NativeChatFollowUpBehavior
    hasDraft: boolean
    chordSteersHead: boolean
  },
  steerHead: (() => boolean) | undefined,
  send: (intent?: NativeChatComposerSendIntent) => void,
  pickerOpen: boolean
) {
  return useSteerChordPreview(
    root,
    sendState,
    steerHead,
    () => send({ alternate: true }),
    pickerOpen,
    isMacPlatform() ? 'Meta' : 'Control'
  )
}
