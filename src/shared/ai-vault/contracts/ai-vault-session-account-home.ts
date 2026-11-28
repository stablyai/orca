import { z } from 'zod'
import {
  isAgentSessionAccountHome,
  type AgentSessionAccountHome
} from '../../agent-session/lifecycle/accounts/agent-session-account-home'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'

export const AiVaultSessionAccountHomeSchema = lazyZodSchema(() =>
  z
    .custom<AgentSessionAccountHome>(isAgentSessionAccountHome)
    .nullable()
    .optional()
    .catch(undefined)
)
