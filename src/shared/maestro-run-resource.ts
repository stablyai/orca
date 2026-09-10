import { z } from 'zod'
import { containsAgentGraphControlCharacter } from './workspace-scope'

export const MAESTRO_RUN_RESOURCE_LIMIT = 512

const reference = z
  .string()
  .min(1)
  .max(12_288)
  .refine(
    (value) => !containsAgentGraphControlCharacter(value),
    'Control characters are not allowed'
  )
const text = z.string().trim().min(1).max(2_048)

export const MaestroRunResourceSchema = z
  .object({
    kind: z.enum([
      'coordinator',
      'task',
      'attempt',
      'dispatch',
      'provider',
      'terminal',
      'browser',
      'cleanup'
    ]),
    reference,
    parent_reference: reference.optional(),
    activation_reference: reference.optional(),
    title: text,
    detail: text,
    state: z.enum([
      'loading',
      'active',
      'input_required',
      'blocked',
      'recovered',
      'unverifiable',
      'completed',
      'error'
    ]),
    model: z.string().trim().min(1).max(512).optional(),
    surface_key: reference.optional(),
    terminal_handle: reference.optional(),
    liveness: z.enum(['live', 'unverifiable', 'exited']).optional()
  })
  .strict()

export const MaestroRunResourcesSchema = z
  .array(MaestroRunResourceSchema)
  .max(MAESTRO_RUN_RESOURCE_LIMIT)

export type MaestroRunResource = z.infer<typeof MaestroRunResourceSchema>
