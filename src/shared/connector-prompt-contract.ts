import * as z from 'zod'
import { lazyZodSchema } from './schema/lazy-zod-schema'
import type { PendingPrompt } from './agent-status/contracts/agent-pending-prompt'

/** Who raised a bot link's prompt, sent only to a cloud that lists prompts.audience. 'conversation':
 *  the turn its conversation asked for; 'orca': anything else, which that cloud masks in a shared
 *  place. wokenBy: with 'orca', who woke the turn. open: the chat, and its item, an Orca link opens. */
export type ConnectorPromptAudience = {
  raisedBy?: 'conversation' | 'orca'
  wokenBy?: string
  open?: { sessionId: string; itemId?: string }
}
export type ConnectorPrompt = PendingPrompt & ConnectorPromptAudience
export const CONNECTOR_PROMPT_LIMITS = {
  maxWokenByChars: 64,
  maxOpaqueIdLength: 128,
  maxTextBytes: 1500,
  maxAnsweredWithChars: 80
} as const
export const CONNECTOR_ANSWER_TEXT_FEATURE = 'answer.text'
export const CONNECTOR_AUDIENCE_EVENTS_VERSION = 2
export type ConnectorAnswer =
  | { optionId: string; text?: never }
  | { text: string; optionId?: never }

export const ConnectorAnswerFields = {
  promptId: lazyZodSchema(() => z.string().min(1)),
  optionId: lazyZodSchema(() => z.string().min(1).optional()),
  text: lazyZodSchema(() => z.string().min(1).max(4000).optional())
}
