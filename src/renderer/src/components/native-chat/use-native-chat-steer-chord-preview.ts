import { useEffect, useState, type RefObject } from 'react'
import type { NativeChatFollowUpBehavior } from '../../../../shared/native-chat/input/native-chat-follow-up-behavior'
import { createNativeChatSteerChordPreviewHook } from '../../../../shared/native-chat/input/use-native-chat-steer-chord-preview'
import type { NativeChatComposerSendIntent } from './native-chat-composer-types'
import { isMacPlatform } from './native-chat-shortcut'

export { NATIVE_CHAT_STEER_CHORD_HOLD_MS } from '../../../../shared/native-chat/input/use-native-chat-steer-chord-preview'
export type { NativeChatSteerChordPreview } from '../../../../shared/native-chat/input/use-native-chat-steer-chord-preview'

const useSteerChordPreview = createNativeChatSteerChordPreviewHook({ useEffect, useState })

export function useNativeChatSteerChordPreview(
  root: RefObject<HTMLElement | null>,
  {
    alternateSend,
    hasDraft,
    sendHeld = false,
    chordSteersQueued
  }: {
    alternateSend?: NativeChatFollowUpBehavior
    hasDraft: boolean
    sendHeld?: boolean
    chordSteersQueued: boolean
  },
  steerQueued: (() => boolean) | undefined,
  send: (intent?: NativeChatComposerSendIntent) => void,
  pickerOpen: boolean
) {
  return useSteerChordPreview(
    root,
    {
      alternateSend: sendHeld ? undefined : alternateSend,
      hasDraft,
      chordSteersHead: !sendHeld && chordSteersQueued
    },
    steerQueued,
    () => send({ alternate: true }),
    pickerOpen,
    isMacPlatform() ? 'Meta' : 'Control'
  )
}
