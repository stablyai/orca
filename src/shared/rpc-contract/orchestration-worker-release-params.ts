import { z } from 'zod'

const workerSubject = {
  paneKey: z.string().min(1).optional(),
  sessionId: z.string().min(1).optional(),
  terminal: z.string().min(1).optional()
}

function namesWorker(value: { paneKey?: string; sessionId?: string; terminal?: string }): boolean {
  return Boolean(value.paneKey ?? value.sessionId ?? value.terminal)
}

/** A worker terminal or chat, named by pane, structured session or terminal handle. */
export const OrchestrationWorkerSubjectParams = z
  .object(workerSubject)
  .refine(namesWorker, 'Missing paneKey, sessionId or terminal')

export const OrchestrationWorkerKeepOpenParams = z
  .object({ ...workerSubject, keep: z.boolean() })
  .refine(namesWorker, 'Missing paneKey, sessionId or terminal')
