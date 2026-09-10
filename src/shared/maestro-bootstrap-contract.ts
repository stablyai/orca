import { z } from 'zod'
import {
  AgentGraphWorkspaceScopeSchema,
  containsAgentGraphControlCharacter
} from './workspace-scope'

export const MAESTRO_BOOTSTRAP_IDENTITY_MAX_LENGTH = 512

const BoundedIdentitySchema = z
  .string()
  .min(1)
  .max(MAESTRO_BOOTSTRAP_IDENTITY_MAX_LENGTH)
  .refine(
    (value) => !containsAgentGraphControlCharacter(value),
    'Control characters are not allowed'
  )

export const MaestroBootstrapMutationIdentitySchema = z
  .object({
    mutation_id: BoundedIdentitySchema,
    execution_host_id: BoundedIdentitySchema,
    workspace_key: BoundedIdentitySchema,
    run_id: BoundedIdentitySchema
  })
  .strict()

export const MaestroBootstrapRequestSchema = z
  .object({
    schema_version: z.literal(1),
    protocol: z.literal('maestro-bootstrap/v1'),
    mutation: MaestroBootstrapMutationIdentitySchema,
    coordinator_generation: z.number().int().positive()
  })
  .strict()

export const MaestroBootstrapReceiptSchema = z
  .object({
    schema_version: z.literal(1),
    protocol: z.literal('maestro-bootstrap-receipt/v1'),
    mutation: MaestroBootstrapMutationIdentitySchema,
    coordinator_generation: z.number().int().positive(),
    workspace_scope: AgentGraphWorkspaceScopeSchema,
    projection_revision: z.literal(0),
    outcome: z.enum(['published', 'replayed'])
  })
  .strict()
  .superRefine((receipt, context) => {
    const scope = receipt.workspace_scope
    if (receipt.mutation.execution_host_id !== scope.execution_host.id) {
      context.addIssue({
        code: 'custom',
        path: ['mutation', 'execution_host_id'],
        message: 'Mutation execution host does not match the workspace scope'
      })
    }
    if (receipt.mutation.workspace_key !== scope.execution_workspace.workspace_key) {
      context.addIssue({
        code: 'custom',
        path: ['mutation', 'workspace_key'],
        message: 'Mutation workspace does not match the workspace scope'
      })
    }
    if (receipt.mutation.run_id !== scope.run_id) {
      context.addIssue({
        code: 'custom',
        path: ['mutation', 'run_id'],
        message: 'Mutation run does not match the workspace scope'
      })
    }
    if (receipt.coordinator_generation !== scope.coordinator_generation) {
      context.addIssue({
        code: 'custom',
        path: ['coordinator_generation'],
        message: 'Coordinator generation does not match the workspace scope'
      })
    }
  })

export type MaestroBootstrapMutationIdentity = z.infer<
  typeof MaestroBootstrapMutationIdentitySchema
>
export type MaestroBootstrapRequest = z.infer<typeof MaestroBootstrapRequestSchema>
export type MaestroBootstrapReceipt = z.infer<typeof MaestroBootstrapReceiptSchema>

export function parseMaestroBootstrapRequest(value: unknown): MaestroBootstrapRequest {
  return MaestroBootstrapRequestSchema.parse(value)
}

export function parseMaestroBootstrapReceipt(value: unknown): MaestroBootstrapReceipt {
  return MaestroBootstrapReceiptSchema.parse(value)
}
