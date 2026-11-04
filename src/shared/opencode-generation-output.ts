import { z } from 'zod'
import { textGenerationFailure } from './text-generation-failure-copy'

const eventSchema = z.object({
  type: z.string(),
  part: z.object({ id: z.string().optional(), text: z.string().optional() }).optional(),
  error: z
    .object({
      name: z.string().optional(),
      message: z.string().optional(),
      data: z.object({ message: z.string().optional() }).optional()
    })
    .optional()
})

/** `errorCode` marks Orca's own parse failures; an uncoded `error` is the agent's text. */
export type GenerationOutputParse =
  | { ok: true; text: string }
  | { ok: false; error: string; errorCode?: string }

export function parseOpenCodeGenerationOutput(stdout: string): GenerationOutputParse {
  const parts = new Map<string, string>()
  let anonymousPart = 0
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) {
      continue
    }
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      return { ok: false, ...textGenerationFailure('openCodeInvalidEvents') }
    }
    const parsed = eventSchema.safeParse(value)
    if (!parsed.success) {
      return { ok: false, ...textGenerationFailure('openCodeInvalidEvents') }
    }
    const event = parsed.data
    if (event.type === 'step_start') {
      parts.clear()
    }
    if (event.type === 'error') {
      return {
        ok: false,
        error:
          event.error?.data?.message ??
          event.error?.message ??
          event.error?.name ??
          'OpenCode reported an error.'
      }
    }
    if (event.type === 'text' && event.part?.text !== undefined) {
      parts.set(event.part.id ?? `anonymous-${anonymousPart++}`, event.part.text)
    }
  }
  return { ok: true, text: [...parts.values()].join('\n') }
}
