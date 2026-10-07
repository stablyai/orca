import { z } from 'zod'

export const OrchestrationWorkerTerminalUserInputParams = z
  .object({
    paneKey: z.string().min(1).optional(),
    sessionId: z.string().min(1).optional(),
    terminal: z.string().min(1).optional()
  })
  .refine(
    (value) => Boolean(value.paneKey ?? value.sessionId ?? value.terminal),
    'Missing paneKey, sessionId or terminal'
  )
