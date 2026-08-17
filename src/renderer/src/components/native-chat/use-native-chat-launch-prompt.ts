import { useEffect, useMemo, useRef } from 'react'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { useAppStore } from '../../store'
import { launchPromptAsMessage, shouldPruneLaunchPrompt } from './native-chat-launch-prompt'
import type { NativeChatTranscriptOrder } from './native-chat-transcript-order'

export function useNativeChatLaunchPrompt(args: {
  terminalTabId: string
  agent: string
  messages: NativeChatMessage[]
  transcriptOrder: NativeChatTranscriptOrder
  crossClock: boolean
}): { message: NativeChatMessage | null; failed: boolean } {
  const { terminalTabId, agent, messages, transcriptOrder, crossClock } = args
  const launchPrompt = useAppStore(
    (state) => state.nativeChatLaunchPromptByTabId[terminalTabId] ?? null
  )
  const clearLaunchPrompt = useAppStore((state) => state.clearNativeChatLaunchPrompt)
  const paneLaunchPrompt = launchPrompt?.agent === agent ? launchPrompt : null
  const launchGenerationRef = useRef(transcriptOrder.generation)
  useEffect(() => {
    if (launchGenerationRef.current !== transcriptOrder.generation && paneLaunchPrompt) {
      // A launch echo belongs to the source generation that existed at send;
      // never let a replacement baseline retire it by identical content.
      clearLaunchPrompt(terminalTabId)
    }
    launchGenerationRef.current = transcriptOrder.generation
  }, [clearLaunchPrompt, paneLaunchPrompt, terminalTabId, transcriptOrder.generation])

  useEffect(() => {
    if (
      paneLaunchPrompt &&
      shouldPruneLaunchPrompt(paneLaunchPrompt, messages, {
        crossClock,
        transcriptOrder
      })
    ) {
      clearLaunchPrompt(terminalTabId)
    }
  }, [clearLaunchPrompt, crossClock, messages, paneLaunchPrompt, terminalTabId, transcriptOrder])

  const message = useMemo(
    () =>
      launchPromptAsMessage(paneLaunchPrompt, messages, {
        crossClock,
        transcriptOrder
      }),
    [crossClock, messages, paneLaunchPrompt, transcriptOrder]
  )
  return { message, failed: paneLaunchPrompt?.failed === true }
}
