import { z } from 'zod'
import { isTuiAgent } from './catalog/tui-agent-config'
import type { TuiAgent } from './catalog/tui-agent'
import {
  normalizeAgentModelOptionChoices,
  type AgentModelOptionChoices
} from './choices/agent-launch-choices'

export const projectAgentLaunchDefaultSchema = z
  .object({
    agent: z.custom<TuiAgent>(isTuiAgent),
    surface: z.enum(['chat', 'terminal']),
    choices: z.unknown().transform<AgentModelOptionChoices>((value, ctx) => {
      const choices = normalizeAgentModelOptionChoices(value)
      if (choices) {
        return choices
      }
      if (
        value &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        !Object.keys(value).length
      ) {
        return {}
      }
      ctx.addIssue({ code: 'custom', message: 'Invalid agent model choices' })
      return z.NEVER
    })
  })
  .strict()

export type ProjectAgentLaunchDefault = z.infer<typeof projectAgentLaunchDefaultSchema>

export function sameProjectAgentLaunchDefault(
  a: ProjectAgentLaunchDefault | null | undefined,
  b: ProjectAgentLaunchDefault | null | undefined
): boolean {
  if (!a || !b) {
    return !a && !b
  }
  return (
    a.agent === b.agent &&
    a.surface === b.surface &&
    a.choices.model === b.choices.model &&
    Object.keys(a.choices.options ?? {}).length === Object.keys(b.choices.options ?? {}).length &&
    Object.entries(a.choices.options ?? {}).every(
      ([key, value]) => b.choices.options?.[key] === value
    )
  )
}
