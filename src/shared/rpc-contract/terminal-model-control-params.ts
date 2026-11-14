import * as z from 'zod'
import { isTuiAgent } from '../agent-launch/catalog/tui-agent-config'
import type { TuiAgent } from '../agent-launch/catalog/tui-agent'

const Value = z.union([z.string().max(8192), z.boolean()])
const OptionId = z.string().min(1).max(128)
export const TerminalModelControlParams = z.object({
  terminal: z.string().min(1),
  expectedIncarnationId: z.string().min(1).optional(),
  agent: z.custom<TuiAgent>((value) => typeof value === 'string' && isTuiAgent(value)),
  intent: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('set'),
      optionId: OptionId,
      value: Value,
      modelId: z.string().max(8192).optional(),
      values: z
        .record(z.string().max(128), Value)
        .refine((values) => Object.keys(values).length <= 32)
        .optional()
    }),
    z.object({ kind: z.literal('picker'), optionId: OptionId }),
    z.object({
      kind: z.literal('toggle'),
      optionId: OptionId,
      modelId: z.string().max(8192).optional()
    })
  ]),
  observation: z
    .object({
      detectAgentInteraction: z.literal('claude-model-switch-confirmation').optional(),
      expectedChoiceLabel: z.string().max(8192).optional()
    })
    .optional(),
  client: z.object({ id: z.string().min(1).max(256), type: z.enum(['desktop', 'mobile']) })
})
