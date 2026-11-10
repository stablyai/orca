import { z } from 'zod'
import type { TuiAgent } from '../agent-launch/catalog/tui-agent'
import { isTuiAgent } from '../agent-launch/catalog/tui-agent-config'

export const TerminalChatPromptParam = z
  .object({
    agent: z.custom<TuiAgent>(isTuiAgent),
    text: z.string(),
    imagePaths: z
      .array(
        z
          .string()
          .min(1)
          .refine((path) => !path.includes('\0'))
      )
      .optional()
  })
  .strict()
  .optional()
