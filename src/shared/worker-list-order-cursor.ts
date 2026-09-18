import { z } from 'zod'

const orderedCursor = z.object({
  version: z.literal(4),
  order: z.literal('desc'),
  run: z.string().min(1).nullable(),
  terminalState: z.string().min(1).nullable(),
  cursor: z.string().min(1).max(2048)
})

export function decodeWorkerListOrderCursor(value: string) {
  try {
    const parsed = orderedCursor.safeParse(
      JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
    )
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

export function encodeWorkerListOrderCursor(
  params: { run?: string; terminalState?: string },
  cursor: string
): string {
  return Buffer.from(
    JSON.stringify({
      version: 4,
      order: 'desc',
      run: params.run ?? null,
      terminalState: params.terminalState ?? null,
      cursor
    })
  ).toString('base64url')
}
