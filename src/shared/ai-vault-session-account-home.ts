import { z } from 'zod'
import {
  isAgentSessionAccountHome,
  type AgentSessionAccountHome
} from './agent-session-account-home'

export const AiVaultSessionAccountHomeSchema = z
  .custom<AgentSessionAccountHome>(isAgentSessionAccountHome)
  .nullable()
  .optional()
  .catch(undefined)
