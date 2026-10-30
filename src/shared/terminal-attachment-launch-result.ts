import { z } from 'zod'
import type { SleepingAgentLaunchConfig, TerminalLaunchResult } from './agent-session-resume'
import { isTuiAgent } from './tui-agent-config'
import type { TuiAgent } from './tui-agent'
import { ResumeProviderSessionParam } from './rpc-contract/terminal-unary-params'
import { sleepingAgentLaunchConfigBaseSchema } from './workspace-session-sleeping-agents'

/** A launch recipe for a pane the window was not shown; the reveal otherwise carries it. */
export type PaneLaunchRecipe = Pick<TerminalLaunchResult, 'launchToken' | 'launchAgent'> & {
  tabId: string
  leafId: string
  launchConfig: SleepingAgentLaunchConfig
}

export type TerminalAttachmentLaunchResult = TerminalLaunchResult & {
  ptyId: string
  incarnationId: string
}

const launchResultSchema = z.object({
  ptyId: z.string().min(1),
  incarnationId: z.string().min(1),
  savedResumeDecision: z
    .object({
      agent: z.string().min(1),
      providerSession: ResumeProviderSessionParam,
      verdict: z.enum(['admitted', 'chat-home', 'chat-writing', 'unverifiable'])
    })
    .optional(),
  agentResumeUnavailable: z.literal(true).optional(),
  agentResumeRefused: z.enum(['chat-home', 'chat-writing', 'unverifiable']).optional(),
  refusedResume: z
    .object({
      agent: z.string().min(1),
      providerSession: ResumeProviderSessionParam,
      expectedStatus: z
        .object({
          paneKey: z.string().min(1),
          receivedAt: z.number().finite(),
          stateStartedAt: z.number().finite()
        })
        .optional(),
      expectedSavedRecord: z
        .object({
          paneKey: z.string().min(1),
          capturedAt: z.number().finite(),
          updatedAt: z.number().finite()
        })
        .optional()
    })
    .optional(),
  launchConfig: sleepingAgentLaunchConfigBaseSchema.optional(),
  launchAgent: z.custom<TuiAgent>(isTuiAgent).optional(),
  launchToken: z.string().min(1).optional(),
  resumeProviderSession: ResumeProviderSessionParam.optional()
})

export function parseTerminalAttachmentLaunchResult(
  value: unknown
): TerminalAttachmentLaunchResult | undefined {
  const result = launchResultSchema.safeParse(value)
  return result.success ? result.data : undefined
}
