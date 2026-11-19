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
  return {
    prompt,
    // Keyed by item: a refused resume puts the card back at a later revision.
    failed: prompt !== null && failed === prompt.itemId,
    dismiss: () => setDismissed(prompt?.itemId ?? null),
    /** A refused answer keeps the card answerable and says it couldn't be resumed. */
    response: (inner: PromptResponse): PromptResponse => ({
      holds: inner.holds,
      respond: async (item, choice) => {
        setFailed(null)
        const result = await inner.respond(item, choice)
        if (result === null) {
          setFailed(item.itemId)
        }
        return result
      }
    })
  }
}
