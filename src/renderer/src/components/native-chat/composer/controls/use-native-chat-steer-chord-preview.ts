import { useEffect, useState, type RefObject } from 'react'
import type { NativeChatFollowUpBehavior } from '../../../../../../shared/native-chat/input/composer/native-chat-follow-up-behavior'
import { createNativeChatSteerChordPreviewHook } from '../../../../../../shared/native-chat/input/composer/use-native-chat-steer-chord-preview'

import type { NativeChatComposerSendIntent } from '../submit/native-chat-composer-send-intent'
import { isMacPlatform } from '../../pane/routing/native-chat-shortcut'

const useSteerChordPreview = createNativeChatSteerChordPreviewHook({ useEffect, useState })

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
