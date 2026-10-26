import { z } from 'zod'
import { AGENT_PERMISSION_CHOICES } from '../tui-agent-permission-choice'
import type { AgentTerminalResume } from '../agent-terminal-resume'

const env = z.record(z.string(), z.string())
const profile = z
  .object({
    agentCmdOverrides: z.record(z.string(), z.string()).optional(),
    agentDefaultArgs: z.record(z.string(), z.string()).optional(),
    agentDefaultEnv: z.record(z.string(), env).optional(),
    agentPermissionDefault: z.enum(AGENT_PERMISSION_CHOICES).optional(),
    agentPermissionOverrides: z.record(z.string(), z.enum(AGENT_PERMISSION_CHOICES)).optional()
  })
  .strict()

export const AgentTerminalResumeParam: z.ZodType<AgentTerminalResume> = z
  .object({
    recipe: z.discriminatedUnion('source', [
      z.object({ source: z.literal('host-defaults') }).strict(),
      z
        .object({
          source: z.literal('current-inputs'),
          settings: profile,
          agentArgs: z.string().nullable().optional()
        })
        .strict(),
      z
        .object({
          source: z.literal('saved'),
          launchConfig: z
            .object({
              agentCommand: z.string().optional(),
              agentArgs: z.string(),
              agentEnv: env,
              ompResumeFilePath: z.string().optional()
            })
            .strict()
            .optional()
        })
        .strict()
    ]),
    ompResumeFilePath: z.string().min(1).max(32768).optional(),
    resumeInLaunchCwd: z.boolean().optional(),
    codexHome: z.string().min(1).max(32768).nullable().optional()
  })
  .strict()
