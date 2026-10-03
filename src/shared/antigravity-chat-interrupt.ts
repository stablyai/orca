import { z } from 'zod'

export const ANTIGRAVITY_CHAT_INTERRUPT_CAPABILITY = 'native-chat.antigravity-interrupt.v1' as const

export const AntigravityChatInterrupt = z.object({
  terminal: z.string().min(1).max(512),
  providerSessionId: z.string().min(1).max(512),
  observation: z.object({
    authorityId: z.string().min(1).max(512),
    incarnation: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
  })
})

export type AntigravityChatInterruptRequest = z.infer<typeof AntigravityChatInterrupt>
export type AntigravityChatInterruptResult = {
  accepted: boolean
  inferred: boolean
  reason?: 'unsupported' | 'stale' | 'refused' | 'unverifiable'
}
