import * as z from 'zod'
import { BOT_AGENTS } from '../bot-types'
import { AGENT_CHAT_PERMISSION_MODES } from '../agent-launch/permissions/agent-chat-permission-mode'
import { requiredString } from './rpc-param-primitives'

export const BotAgentSwitchPreview = z.strictObject({
  botId: requiredString('Missing bot id'),
  agent: z.enum(BOT_AGENTS)
})

export const BotAgentSwitchConsent = z.strictObject({
  agent: z.enum(BOT_AGENTS),
  from: z.enum(BOT_AGENTS),
  defaultPermission: z.enum([...AGENT_CHAT_PERMISSION_MODES, 'own']),
  home: z
    .strictObject({
      sessionId: z.string().min(1).max(512),
      from: z.string().min(1).max(128),
      permission: z.enum([...AGENT_CHAT_PERMISSION_MODES, 'own'])
    })
    .nullable()
})

export const BotAgentSwitchPreviewResultSchema = z.strictObject({
  consent: BotAgentSwitchConsent.nullable(),
  saveExplicitAsk: z.literal(true).optional()
})
export type BotAgentSwitchPreviewResult = z.infer<typeof BotAgentSwitchPreviewResultSchema>
