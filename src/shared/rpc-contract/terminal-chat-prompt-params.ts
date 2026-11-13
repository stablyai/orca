import { z } from 'zod'
import type { TuiAgent } from '../agent-launch/catalog/tui-agent'
import { isTuiAgent } from '../agent-launch/catalog/tui-agent-config'

export const TerminalChatPromptParam = z
  .object({
    agent: z.custom<TuiAgent>(isTuiAgent),
    text: z.string()
  })
  .strict()
  .optional()
