import {
  AGENT_SESSION_ATTACHMENT_CHUNK_BASE64_CHARS,
  sanitizeAgentSessionAttachmentName
} from '../agent-session/agent-session-attachments'
import { z } from 'zod'
export const FeishuLocalBot = z.strictObject({ botId: z.string().min(1) })
export const FeishuLocalConnect = FeishuLocalBot.extend({ profile: z.string().min(1).max(128) })

export const FeishuGeneratedFile = z.strictObject({
  sessionId: z.string().min(1),
  name: z
    .string()
    .min(1)
    .max(200)
    .refine((v) => sanitizeAgentSessionAttachmentName(v) === v),
  base64: z.string().min(4).max(AGENT_SESSION_ATTACHMENT_CHUNK_BASE64_CHARS).base64()
})
