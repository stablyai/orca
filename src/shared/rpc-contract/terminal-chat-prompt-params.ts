import { z } from 'zod'
import type { TuiAgent } from '../agent-launch/catalog/tui-agent'
import { isTuiAgent } from '../agent-launch/catalog/tui-agent-config'

export const TerminalChatPromptParam = z
  .object({
    agent: z.custom<TuiAgent>(isTuiAgent),
    text: z.string(),
    expiry: z
      .object({
        runtimeId: z.string().min(1).max(4096),
        expiresAtMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
      })
      .strict()
      .optional()
  })
  .strict()
  .optional()
