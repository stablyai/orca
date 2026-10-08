import { useCallback, useState } from 'react'
import type { useStructuredAgentSession } from './use-structured-agent-session'

type Respond = ReturnType<typeof useStructuredAgentSession>['respond']
type PromptItem = Parameters<Respond>[0]

const promptKey = (item: PromptItem): string => `${item.itemId}:${item.revision}`

/**
 * Holds a prompt card from the press until the host refuses the response. An accepted one stays
 * held: the host retires that prompt, and a second response to it would only be refused.
 */
export function useStructuredPromptResponseHold(respond: Respond): {
  respond: Respond
  holds: (item: PromptItem) => boolean
} {
  const [heldKey, setHeldKey] = useState<string | null>(null)
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
    [respond]
  )
  return { respond: holdingRespond, holds: (item) => heldKey === promptKey(item) }
}
