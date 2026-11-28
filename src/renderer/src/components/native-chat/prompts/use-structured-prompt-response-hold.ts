import { useCallback } from 'react'
import { useNativeChatViewState } from '../pane/ownership/native-chat-view-memory'
import type { useStructuredAgentSession } from '../session/structured/use-structured-agent-session'

type Respond = ReturnType<typeof useStructuredAgentSession>['respond']
type PromptItem = Parameters<Respond>[0]

const promptKey = (item: PromptItem): string => `${item.itemId}:${item.revision}`

/** Hold from response press until refusal; acceptance keeps the hold until the host retires the prompt to prevent duplicate responses. */
export function useStructuredPromptResponseHold(respond: Respond): {
  respond: Respond
  holds: (item: PromptItem) => boolean
} {
  // Kept with the tab, so a view released mid-response still blocks a second response when it returns.
  const [heldKey, setHeldKey] = useNativeChatViewState<string | null>('prompt-response-hold', null)
  const holdingRespond = useCallback<Respond>(
    async (item, response) => {
      const key = promptKey(item)
      setHeldKey(key)
      const release = (): void => setHeldKey((held) => (held === key ? null : held))
      try {
        const result = await respond(item, response)
        if (result === null) {
          release()
        }
        return result
      } catch (error) {
        release()
        throw error
      }
    },
    [respond, setHeldKey]
  )
  return { respond: holdingRespond, holds: (item) => heldKey === promptKey(item) }
}
