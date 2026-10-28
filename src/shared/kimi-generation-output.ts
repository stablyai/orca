import { z } from 'zod'

const messageSchema = z.discriminatedUnion('role', [
  z
    .object({
      role: z.literal('assistant'),
      content: z.string().optional(),
      tool_calls: z
        .array(
          z.object({
            type: z.literal('function'),
            id: z.string(),
            function: z.object({ name: z.string(), arguments: z.string() })
          })
        )
        .optional()
    })
    .refine((message) => message.content !== undefined || (message.tool_calls?.length ?? 0) > 0),
  z.object({ role: z.literal('tool'), tool_call_id: z.string(), content: z.string() }),
  z.object({ role: z.literal('meta'), type: z.string() })
])

export function parseKimiGenerationOutput(
  stdout: string
): { ok: true; text: string } | { ok: false; error: string } {
  let answer = ''
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) {
      continue
    }
    let value: unknown
    try {
      value = JSON.parse(line)
    } catch {
      return { ok: false, error: "Kimi returned output Orca couldn't read. Try again." }
    }
    const parsed = messageSchema.safeParse(value)
    if (!parsed.success) {
      return { ok: false, error: "Kimi returned output Orca couldn't read. Try again." }
    }
    const message = parsed.data
    if (message.role === 'assistant') {
      // Tool narration invalidates any earlier hook or answer candidate.
      answer = message.tool_calls?.length ? '' : (message.content ?? '')
    }
  }
  return { ok: true, text: answer }
}

const failureSchema = z.object({ type: z.literal('error'), code: z.string() })

export function findKimiGenerationFailure(stdout: string): string | null {
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) {
      continue
    }
    try {
      const value: unknown = JSON.parse(line)
      const failure = failureSchema.safeParse(value)
      if (failure.success && failure.data.code === 'session.occupied') {
        return "Kimi couldn't use this session because it is active in another client. Stop the session there or exit that client, then try again."
      }
    } catch {
      // Failed stdout can contain partial records before the declared refusal.
    }
  }
  return null
}
