import { z } from 'zod'
import { textGenerationFailure } from './text-generation-failure-copy'
import type { GenerationOutputParse } from './opencode-generation-output'

export function buildAntigravityGenerationInput(prompt: string): string {
  return `${JSON.stringify({
    event: 'user',
    message: { role: 'user', content: [{ type: 'text', text: prompt }] }
  })}\n`
}

const eventSchema = z.object({ event: z.string() })
const resultSchema = z.object({
  status: z.string(),
  response: z.string(),
  error: z.string().optional()
})
const resultEventSchema = eventSchema.extend({ result: resultSchema })

export function parseAntigravityGenerationOutput(stdout: string): GenerationOutputParse {
  let result: z.infer<typeof resultSchema> | undefined
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) {
      continue
    }
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      return { ok: false, ...textGenerationFailure('antigravityInvalidEvents') }
    }
    const event = eventSchema.safeParse(value)
    if (!event.success) {
      return { ok: false, ...textGenerationFailure('antigravityInvalidEvents') }
    }
    if (event.data.event === 'result') {
      const parsed = resultEventSchema.safeParse(value)
      if (!parsed.success) {
        return { ok: false, ...textGenerationFailure('antigravityInvalidResult') }
      }
      result = parsed.data.result
      if (result.status !== 'SUCCESS') {
        return { ok: false, error: result.error || 'Antigravity reported an error.' }
      }
    }
  }
  return result
    ? { ok: true, text: result.response }
    : { ok: false, ...textGenerationFailure('antigravityNoFinalResult') }
}
