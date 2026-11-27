import { z } from 'zod'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'

const createWorkerSubject = () => ({
  paneKey: z.string().min(1).optional(),
  sessionId: z.string().min(1).optional(),
  terminal: z.string().min(1).optional()
})

function namesWorker(value: { paneKey?: string; sessionId?: string; terminal?: string }): boolean {
  return Boolean(value.paneKey ?? value.sessionId ?? value.terminal)
}

/** A worker terminal or chat, named by pane, structured session or terminal handle. */
export const OrchestrationWorkerSubjectParams = lazyZodSchema(() =>
  z.object(createWorkerSubject()).refine(namesWorker, 'Missing paneKey, sessionId or terminal')
)

export const OrchestrationWorkerKeepOpenParams = lazyZodSchema(() =>
  z
    .object({ ...createWorkerSubject(), keep: z.boolean() })
    .refine(namesWorker, 'Missing paneKey, sessionId or terminal')
)
