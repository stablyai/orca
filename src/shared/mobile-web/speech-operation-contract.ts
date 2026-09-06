import { z } from 'zod'

const SpeechModelIdSchema = z.string().min(1).max(128)
export const MOBILE_WEB_SPEECH_STOP_TIMEOUT_MS = 80_000

export const MobileWebSpeechSetupPayloadSchema = z.object({}).strict()
export const MobileWebSpeechModelSchema = z
  .object({
    id: SpeechModelIdSchema,
    label: z.string().min(1).max(240),
    provider: z.enum(['local', 'openai']),
    sizeBytes: z
      .number()
      .int()
      .nonnegative()
      .max(16 * 1024 * 1024 * 1024)
      .nullable(),
    recommended: z.boolean(),
    status: z.enum(['ready', 'not-downloaded', 'downloading', 'extracting', 'error']),
    progress: z.number().min(0).max(1).nullable()
  })
  .strict()
export const MobileWebSpeechSetupResultSchema = z
  .object({
    enabled: z.boolean(),
    selectedModelId: z.string().max(128),
    dictationMode: z.enum(['toggle', 'hold']),
    models: z.array(MobileWebSpeechModelSchema).max(32)
  })
  .strict()

export const MobileWebSpeechModelActionPayloadSchema = z
  .object({ modelId: SpeechModelIdSchema })
  .strict()
export const MobileWebSpeechModelActionResultSchema = z.null()
export const MobileWebSpeechDeleteModelResultSchema = MobileWebSpeechSetupResultSchema
export const MobileWebSpeechConfigurePayloadSchema = z
  .object({
    enabled: z.boolean().optional(),
    modelId: z.string().max(128).optional(),
    dictationMode: z.enum(['toggle', 'hold']).optional()
  })
  .strict()
  .refine(
    (value) =>
      value.enabled !== undefined ||
      value.modelId !== undefined ||
      value.dictationMode !== undefined,
    'At least one dictation setting is required'
  )
export const MobileWebSpeechConfigureResultSchema = MobileWebSpeechSetupResultSchema

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

export type MobileWebSpeechSetup = z.infer<typeof MobileWebSpeechSetupResultSchema>
export type MobileWebSpeechStartResult = z.infer<typeof MobileWebSpeechStartResultSchema>
export type MobileWebSpeechStopResult = z.infer<typeof MobileWebSpeechStopResultSchema>
export type MobileWebSpeechEvent = z.infer<typeof MobileWebSpeechEventSchema>
export type MobileWebSpeechConfigurePayload = z.infer<typeof MobileWebSpeechConfigurePayloadSchema>
