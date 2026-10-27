import { z } from 'zod'

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

export function parseAntigravityGenerationOutput(
  stdout: string
): { ok: true; text: string } | { ok: false; error: string } {
  let result: z.infer<typeof resultSchema> | undefined
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) {
      continue
    }
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      return { ok: false, error: 'Antigravity returned invalid JSON events.' }
    }
    const event = eventSchema.safeParse(value)
    if (!event.success) {
      return { ok: false, error: 'Antigravity returned invalid JSON events.' }
    }
    if (event.data.event === 'result') {
      const parsed = resultEventSchema.safeParse(value)
      if (!parsed.success) {
        return { ok: false, error: 'Antigravity returned an invalid result.' }
      }
      result = parsed.data.result
      if (result.status !== 'SUCCESS') {
        return { ok: false, error: result.error || 'Antigravity reported an error.' }
      }
    }
  }
  return result
    ? { ok: true, text: result.response }
    : { ok: false, error: 'Antigravity returned no final result.' }
}
