import {
  AGENT_SESSION_ATTACHMENT_CHUNK_BASE64_CHARS,
  sanitizeAgentSessionAttachmentName
} from '../agent-session/agent-session-attachments'
import { z } from 'zod'
import { FeishuGroupPolicy } from '../bots/feishu-local'
export const FeishuLocalBot = z.strictObject({ botId: z.string().min(1) })
export const FeishuLocalConnect = z.union([
  FeishuLocalBot.extend({ profile: z.string().min(1).max(128) }),
  FeishuLocalBot.extend({
    appId: z.string().regex(/^cli_[0-9a-fA-F]{16}$/),
    appSecret: z
      .string()
      .min(1)
      .max(256)
      .regex(/^[\x21-\x7e]+$/),
    group: FeishuGroupPolicy.optional()
  })
])

export const FeishuGeneratedFile = z.strictObject({
  sessionId: z.string().min(1),
  name: z
    .string()
    .min(1)
    .max(200)
    .refine((v) => sanitizeAgentSessionAttachmentName(v) === v),
  base64: z.string().min(4).max(AGENT_SESSION_ATTACHMENT_CHUNK_BASE64_CHARS).base64()
})
