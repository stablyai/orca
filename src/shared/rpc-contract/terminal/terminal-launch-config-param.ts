import * as z from 'zod'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'
import { launchConfigClaudeAccountIdSchema } from '../../workspace-session/workspace-session-sleeping-agents'

export const TerminalLaunchConfigParam = lazyZodSchema(() =>
  z.object({
    agentCommand: z.string().optional(),
    agentArgs: z.string(),
    agentEnv: z.record(z.string(), z.string()),
    ompResumeFilePath: z
      .string()
      .min(1)
      .max(32 * 1024)
      .optional(),
    claudeAccountId: launchConfigClaudeAccountIdSchema
  })
)
