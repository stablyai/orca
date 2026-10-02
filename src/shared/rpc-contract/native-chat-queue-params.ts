import { z } from 'zod'
const Queue = z.object({ paneKey: z.string().min(1).max(1024) }).strict()
const QueueMutation = Queue.extend({ expectedRevision: z.number().int().nonnegative() }).strict()
const QueueMessageMutation = QueueMutation.extend({ messageId: z.string().uuid() }).strict()


export const NativeChatQueueReadParams = Queue

export const NativeChatQueueEnqueueParams = QueueMutation.extend({
      text: z.string(),
      imagePaths: z.array(z.string().min(1)),
      kind: z.enum(['chat', 'command'])
    }).strict()

export const NativeChatQueueEditParams = QueueMessageMutation.extend({
      text: z.string(),
      imagePaths: z.array(z.string().min(1)),
      kind: z.enum(['chat', 'command'])
    }).strict()

export const NativeChatQueueBeginEditParams = QueueMessageMutation

export const NativeChatQueueRemoveParams = QueueMessageMutation

export const NativeChatQueueReorderParams = QueueMutation.extend({ messageIds: z.array(z.string().uuid()) }).strict()

export const NativeChatQueueClaimParams = QueueMutation

export const NativeChatQueueAcceptParams = QueueMessageMutation

export const NativeChatQueueRejectParams = QueueMessageMutation.extend({
      uncertain: z.boolean(),
      error: z.string().min(1)
    }).strict()

export const NativeChatQueuePauseParams = QueueMutation

export const NativeChatQueueResumeParams = QueueMutation

export const NativeChatQueueRetryParams = QueueMessageMutation
