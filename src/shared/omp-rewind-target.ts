import { z } from 'zod'

const targetSchema = z.union([
  z.object({ entryId: z.string().min(1) }),
  z.object({ sessionFile: z.string().min(1), timestamp: z.number().finite() })
])

export type OmpRewindTarget = z.infer<typeof targetSchema>

export function encodeOmpRewindTarget(target: OmpRewindTarget): string {
  return JSON.stringify(target)
}

export function decodeOmpRewindTarget(value: string): OmpRewindTarget | null {
  try {
    const parsed = targetSchema.safeParse(JSON.parse(value))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}
