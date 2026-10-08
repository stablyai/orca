import { z } from 'zod'
import { OptionalString, requiredString } from './rpc-param-primitives'

export const AUDIO_BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/

export const DICTATION_SAMPLE_RATE = 16_000

export const PCM_BYTES_PER_SAMPLE = 2

export const MAX_DICTATION_AUDIO_SECONDS = 5

export const MAX_DICTATION_AUDIO_CHUNK_BYTES =
  DICTATION_SAMPLE_RATE * PCM_BYTES_PER_SAMPLE * MAX_DICTATION_AUDIO_SECONDS

export const MAX_DICTATION_AUDIO_CHUNK_BASE64_LENGTH =
  Math.ceil(MAX_DICTATION_AUDIO_CHUNK_BYTES / 3) * 4

export function isValidAudioBase64(value: string): boolean {
  return value.length % 4 !== 1 && AUDIO_BASE64_PATTERN.test(value)
}

export const DictationStart = z.object({
  dictationId: requiredString('Missing dictation ID'),
  modelId: OptionalString
})

export const DictationChunk = z.object({
  dictationId: requiredString('Missing dictation ID'),
  audioBase64: requiredString('Missing audio chunk')
    // Why: feedMobileDictation decodes into Buffer + Float32Array; reject
    // oversized chunks before allocation. This mirrors the mobile pending-audio budget.
    .refine(
      (value) => value.length <= MAX_DICTATION_AUDIO_CHUNK_BASE64_LENGTH,
      'Audio chunk is too large'
    )
    // Why: Buffer.from(..., 'base64') silently drops malformed bytes; reject
    // bad mobile audio chunks instead of feeding empty/corrupt PCM.
    .refine(isValidAudioBase64, 'Audio chunk must be base64'),
  sampleRate: z.number().finite().positive()
})

export const DictationHandle = z.object({
  dictationId: requiredString('Missing dictation ID')
})

export const SpeechModelAction = z.object({
  modelId: requiredString('Missing model ID')
})

export const DictationSetup = z.object({
  enabled: z.boolean().optional(),
  modelId: OptionalString,
  dictationMode: z.enum(['toggle', 'hold']).optional()
})
