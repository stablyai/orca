import { z } from 'zod'

export const MOBILE_WEB_SPEECH_STOP_TIMEOUT_MS = 80_000

export const MobileWebSpeechStartPayloadSchema = z.object({}).strict()
export const MobileWebSpeechStartResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('recording') }).strict(),
  z.object({ status: z.literal('permission-denied') }).strict(),
  z
    .object({
      status: z.literal('setup-required'),
      reason: z.enum([
        'voice_dictation_disabled',
        'voice_model_not_selected',
        'voice_model_not_ready'
      ])
    })
    .strict(),
  z.object({ status: z.literal('unavailable') }).strict()
])

export const MobileWebSpeechStopPayloadSchema = z.object({}).strict()
export const MobileWebSpeechStopResultSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('transcript'),
      text: z
        .string()
        .min(1)
        .max(32 * 1024)
    })
    .strict(),
  z.object({ status: z.literal('no-speech') }).strict(),
  z.object({ status: z.literal('cancelled') }).strict()
])
export const MobileWebSpeechCancelPayloadSchema = z.object({}).strict()
export const MobileWebSpeechCancelResultSchema = z.null()

export const MobileWebSpeechSubscribePayloadSchema = z.object({}).strict()
export const MobileWebSpeechEventSchema = z
  .object({
    status: z.enum(['idle', 'recording', 'processing']),
    reason: z
      .enum([
        'cancelled',
        'interrupted',
        'connection-slow',
        'host-error',
        'session-replaced',
        'disconnected'
      ])
      .optional()
  })
  .strict()

export type MobileWebSpeechStartResult = z.infer<typeof MobileWebSpeechStartResultSchema>
export type MobileWebSpeechStopResult = z.infer<typeof MobileWebSpeechStopResultSchema>
export type MobileWebSpeechEvent = z.infer<typeof MobileWebSpeechEventSchema>
