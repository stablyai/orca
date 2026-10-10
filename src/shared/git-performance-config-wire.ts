import { z } from 'zod'
import {
  GIT_PERFORMANCE_CONFIG_KEYS,
  GIT_PERFORMANCE_CONFIG_SKIP_REASONS,
  type GitPerformanceConfigResult
} from './git-performance-config-types'

// Why validate: a relay built from another Orca version answers this request, so its
// reply is untrusted wire data even though both sides share the TypeScript types.
const Key = z.enum(GIT_PERFORMANCE_CONFIG_KEYS)
const Entry = z.object({ key: Key, value: z.string() })
const KeyPlan = z.union([
  z.object({ key: Key, value: z.string(), action: z.enum(['set', 'keep']) }),
  z.object({
    key: Key,
    action: z.literal('skip'),
    reason: z.enum(GIT_PERFORMANCE_CONFIG_SKIP_REASONS)
  })
])
const Envelope = z.object({
  state: z.object({ orcaKeys: z.array(z.unknown()), userKeys: z.array(z.unknown()) }),
  plan: z.array(z.unknown()).optional(),
  reverted: z.array(z.unknown()).optional()
})

// Why per item: a newer relay may report keys this client does not know; drop them, keep the rest.
function knownItems<T>(schema: z.ZodType<T>, items: readonly unknown[]): T[] {
  return items.flatMap((item) => {
    const parsed = schema.safeParse(item)
    return parsed.success ? [parsed.data] : []
  })
}

export function parseGitPerformanceConfigResult(value: unknown): GitPerformanceConfigResult {
  const envelope = Envelope.parse(value)
  return {
    state: {
      orcaKeys: knownItems(Entry, envelope.state.orcaKeys),
      userKeys: knownItems(Key, envelope.state.userKeys)
    },
    ...(envelope.plan ? { plan: knownItems(KeyPlan, envelope.plan) } : {}),
    ...(envelope.reverted ? { reverted: knownItems(Key, envelope.reverted) } : {})
  }
}
