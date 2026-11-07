import { z } from 'zod'
import { MutationEnvelope } from './structured-agent-session-mutation-envelope'
import { AgentSessionForegroundTaskSchema } from '../agent-session/agent-session-foreground-task'

export const BackgroundTaskParams = z
  .object({
    envelope: MutationEnvelope,
    target: AgentSessionForegroundTaskSchema
  })
  .strict()
