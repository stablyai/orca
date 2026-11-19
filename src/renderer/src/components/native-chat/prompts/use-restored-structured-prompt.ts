import { useMemo, useState } from 'react'
import type { AgentJournalRenderItem } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import { restoredAgentJournalPrompt } from '../../../../../shared/agent-session/requests/prompts/agent-session-restored-prompt'
import type { useStructuredPromptResponseHold } from './use-structured-prompt-response-hold'

type PromptResponse = ReturnType<typeof useStructuredPromptResponseHold>

/** The chat's last prompt when its agent exited waiting on it, derived from the loaded transcript
 *  only while no agent runs; dismissing it gives the composer back without writing anything. */
export function useRestoredStructuredPrompt(
  eligible: boolean,
  journalItems: readonly AgentJournalRenderItem[]
) {
  const [dismissed, setDismissed] = useState<string | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const found = useMemo(
    () => (eligible ? restoredAgentJournalPrompt(journalItems) : null),
    [eligible, journalItems]
  )
  const prompt = found && found.itemId !== dismissed ? found : null
  const key = prompt ? `${prompt.itemId}:${prompt.revision}` : null
  return {
    prompt,
    failed: key !== null && failed === key,
    dismiss: () => setDismissed(prompt?.itemId ?? null),
    /** A refused answer leaves the card readable but says it can't be resumed. */
    response: (inner: PromptResponse): PromptResponse => ({
      holds: (item) => inner.holds(item) || failed === `${item.itemId}:${item.revision}`,
      respond: async (item, choice) => {
        const result = await inner.respond(item, choice)
        if (result === null) {
          setFailed(`${item.itemId}:${item.revision}`)
        }
        return result
      }
    })
  }
}
