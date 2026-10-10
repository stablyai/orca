import { z } from 'zod'
import { Identifier } from './structured-agent-session-identifiers'
import type { AgentSessionStopTarget } from '../agent-session-stop-target'

export const StopTarget = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('turn'), turnId: Identifier('Invalid turn id') }).strict(),
  z
    .object({ kind: z.literal('submission'), clientMessageId: Identifier('Invalid message id') })
    .strict(),
  z
    .object({
      kind: z.literal('background-tasks'),
      tasks: z
        .array(
          z
            .object({
              id: Identifier('Invalid child id'),
              invocation: z
                .object({
                  invocationId: Identifier('Invalid invocation id'),
                  generation: z.number().int().nonnegative()
                })
                .strict()
            })
            .strict()
        )
        .max(512)
    })
    .strict()
])

export function validateCancelStopTarget(
  value: { stopTarget?: AgentSessionStopTarget; scope?: 'background-tasks'; turnId?: string },
  ctx: z.RefinementCtx
): void {
  if (
    value.stopTarget &&
    (value.stopTarget.kind === 'background-tasks') !== (value.scope === 'background-tasks')
  ) {
    ctx.addIssue({ code: 'custom', message: 'Stop target must match its scope' })
  }
  if (
    value.stopTarget?.kind === 'turn' &&
    value.turnId !== undefined &&
    value.turnId !== value.stopTarget.turnId
  ) {
    ctx.addIssue({ code: 'custom', message: 'Stop target must match its turn' })
  }
}
