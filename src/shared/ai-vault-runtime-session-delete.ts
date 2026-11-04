import { z } from 'zod'
import { AI_VAULT_AGENTS } from './ai-vault-types'
import {
  AI_VAULT_SESSION_DELETE_REJECTION_CODES,
  type AiVaultDeleteSessionArgs,
  type AiVaultDeleteSessionResult
} from './ai-vault-session-deletion'
import type { RuntimeRpcResponse } from './runtime-rpc-envelope'

const AiVaultDeleteSessionResultSchema = z.union([
  z.object({ outcome: z.literal('deleted') }),
  z.object({
    outcome: z.literal('rejected'),
    agent: z.enum(AI_VAULT_AGENTS),
    // A newer host may add codes; every rejection renders as one failure message.
    reason: z.enum(AI_VAULT_SESSION_DELETE_REJECTION_CODES).catch('invalid-path')
  }),
  z.object({ outcome: z.literal('failed'), agent: z.enum(AI_VAULT_AGENTS), error: z.string() })
])

/** The owning host validates the path itself, so only the row identity travels. */
export function runtimeAiVaultDeleteSessionParams(
  args: AiVaultDeleteSessionArgs
): Omit<AiVaultDeleteSessionArgs, 'executionHostId'> {
  return {
    agent: args.agent,
    ...(args.sessionId ? { sessionId: args.sessionId } : {}),
    filePath: args.filePath
  }
}

/** A host without aiVault.deleteSession predates it and must be updated. */
export function readRuntimeAiVaultDeleteSessionResponse(
  response: RuntimeRpcResponse<unknown>,
  agent: AiVaultDeleteSessionArgs['agent']
): AiVaultDeleteSessionResult {
  if (response.ok !== true) {
    // Match this exact RPC so a missing method elsewhere on the route is not misread as an old host.
    return response.error.code === 'method_not_found' &&
      response.error.message === 'Unknown method: aiVault.deleteSession'
      ? { outcome: 'rejected', agent, reason: 'host-update-required' }
      : { outcome: 'failed', agent, error: response.error.message }
  }
  const parsed = AiVaultDeleteSessionResultSchema.safeParse(response.result)
  return parsed.success
    ? parsed.data
    : { outcome: 'failed', agent, error: 'Invalid aiVault.deleteSession response' }
}
