import { z } from 'zod'
import { BacklogOperation } from '../backlog-types'

export const BacklogRequest = z.object({
  repoId: z.string().min(1).max(1024),
  operation: BacklogOperation
})
export const BacklogRelayRequest = z.object({
  repoPath: z.string().min(1).max(4096),
  operation: BacklogOperation
})
