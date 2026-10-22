import { z } from 'zod'
import { AI_VAULT_AGENTS } from './ai-vault-types'

export const SEARCH_ELIGIBLE_PANES_MAX = 2048
export const SEARCH_ELIGIBLE_PROMPTS_MAX = 128
export const SEARCH_ELIGIBLE_TEXT_MAX = 4096

export const AiVaultSearchEligibleSessionsSchema = z
  .object({
    providers: z
      .array(z.object({ agent: z.enum(AI_VAULT_AGENTS), sessionId: z.string().min(1).max(512) }))
      .max(SEARCH_ELIGIBLE_PANES_MAX),
    /** One entry per target: two matching targets remain ambiguous. */
    prompts: z
      .array(
        z.object({
          agent: z.enum(AI_VAULT_AGENTS),
          prompts: z
            .array(z.string().min(1).max(SEARCH_ELIGIBLE_TEXT_MAX))
            .max(SEARCH_ELIGIBLE_PROMPTS_MAX)
        })
      )
      .max(SEARCH_ELIGIBLE_PANES_MAX)
  })
  .refine(
    (eligible) =>
      eligible.prompts.reduce(
        (total, entry) => total + entry.prompts.reduce((size, prompt) => size + prompt.length, 0),
        0
      ) <= 262144,
    'Eligible prompt text exceeds the search budget'
  )

export type AiVaultSearchEligibleSessions = z.infer<typeof AiVaultSearchEligibleSessionsSchema>

/** Stable ordering without merging prompt entries, whose multiplicity is meaningful. */
export function eligibleSessionsKey(eligible: AiVaultSearchEligibleSessions | undefined): string {
  if (eligible === undefined) {
    return 'null'
  }
  return JSON.stringify({
    providers: [
      ...new Set(eligible.providers.map((entry) => JSON.stringify([entry.agent, entry.sessionId])))
    ].sort(),
    prompts: eligible.prompts
      .map((entry) => JSON.stringify([entry.agent, [...new Set(entry.prompts)].sort()]))
      .sort()
  })
}
