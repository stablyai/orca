import { z } from 'zod'
import type { AgentSessionQueuedMessage } from '../agent-session/requests/agent-session-queued-message-wire'
export { NATIVE_CHAT_TERMINAL_QUEUE_CAPABILITY } from './native-chat-terminal-queue-capability'

export type NativeChatTerminalActivity = {
  state: 'working' | 'idle' | 'waiting' | null
  workingSequence: number
  inputReady?: boolean
}

export const NativeChatTerminalQueueRequest = z.object({
  terminal: z.string().min(1),
  action: z.discriminatedUnion('type', [
    z.object({ type: z.literal('read') }),
    z.object({
      type: z.literal('enqueue'),
      messageId: z.string().uuid(),
      text: z.string().min(1).max(1_000_000)
    }),
    z.object({ type: z.literal('delete'), messageIds: z.array(z.string()).max(100) }),
    z.object({ type: z.literal('edit'), messageId: z.string().min(1) })
  ])
})

export type NativeChatTerminalQueueSnapshot = {
  revision: string
  activity: NativeChatTerminalActivity
  queuedMessages: readonly AgentSessionQueuedMessage[]
}

export const NativeChatTerminalQueueSnapshotSchema = z.object({
  revision: z.string(),
  activity: z.object({
    state: z.enum(['working', 'idle', 'waiting']).nullable(),
    workingSequence: z.number(),
    inputReady: z.boolean().optional()
  }),
  queuedMessages: z.array(
    z.object({
      messageId: z.string(),
      position: z.number(),
      state: z.enum(['waiting', 'returned']),
      body: z.object({
        kind: z.literal('message'),
        role: z.literal('user'),
        blocks: z.array(z.object({ type: z.literal('text'), text: z.string() }))
      }),
      paused: z.literal(true).optional(),
      pausedReason: z.literal('send_failed').optional(),
      returnedReason: z.string().nullable().optional()
    })
  )
})

export function sameNativeChatTerminalQueueSnapshot(
  a: NativeChatTerminalQueueSnapshot,
  b: NativeChatTerminalQueueSnapshot
): boolean {
  return (
    a.revision === b.revision &&
    a.activity.state === b.activity.state &&
    a.activity.workingSequence === b.activity.workingSequence &&
    a.activity.inputReady === b.activity.inputReady
  )
}
