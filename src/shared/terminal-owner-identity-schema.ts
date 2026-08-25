import { z } from 'zod'
import { isTerminalOwnerIdentity } from './terminal-owner-identity'

export const terminalOwnerIdentitySchema = z
  .object({
    executionHostId: z.string().min(1),
    ownerKind: z.enum(['daemon', 'ssh', 'wsl', 'relay', 'paired-runtime', 'local-direct']),
    ownerIncarnationId: z.string().min(1).max(256),
    sessionIncarnationId: z.string().min(1).max(128),
    protocolVersion: z.number().int().positive(),
    endpointRef: z.string().max(512).optional()
  })
  .refine(isTerminalOwnerIdentity)
