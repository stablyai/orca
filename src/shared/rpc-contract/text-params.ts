import * as z from 'zod'

export const TEXT_GENERATE_PROMPT_MAX_CHARS = 200_000
export const TEXT_GENERATE_DEFAULT_TIMEOUT_MS = 5 * 60_000
export const TEXT_GENERATE_MAX_TIMEOUT_MS = 30 * 60_000

export const TextGenerate = z.object({
  agent: z.string().trim().min(1, 'Agent is required').max(64),
  model: z.string().trim().min(1).max(256).optional(),
  effort: z.string().trim().min(1).max(64).optional(),
  prompt: z
    .string()
    .refine((value) => value.trim().length > 0, 'Prompt is required')
    .pipe(z.string().max(TEXT_GENERATE_PROMPT_MAX_CHARS)),
  timeoutMs: z.number().int().positive().max(TEXT_GENERATE_MAX_TIMEOUT_MS).optional()
})

export type TextGenerateRequest = z.infer<typeof TextGenerate>

export type TextGenerateResult =
  | { success: true; text: string; agent: string; model: string; elapsedMs: number }
  | { success: false; error: string; canceled?: boolean; timedOut?: boolean }
