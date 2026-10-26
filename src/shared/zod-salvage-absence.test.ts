// Pin missing-container rejection: bare transforms set neither optin nor optout, and Zod suppresses absent-key issues only when both are optional. A dependency/optionality change must not salvage a foreign payload’s missing tabsByWorktree into an empty session.
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { salvagingArray, salvagingRecord } from './zod-salvage'

type Optionality = { optin?: unknown; optout?: unknown }

function optionalityOf(schema: z.ZodType): Optionality {
  return (schema as unknown as { _zod: Optionality })._zod
}

const CONTAINERS: [string, () => z.ZodType, unknown][] = [
  ['salvagingRecord', () => salvagingRecord(z.string(), z.string()), { k: 'v' }],
  ['salvagingArray', () => salvagingArray(z.string()), ['v']]
]

describe('salvaging containers used bare in an object schema', () => {
  it.each(CONTAINERS)('%s is neither optional-in nor optional-out', (_name, build) => {
    const { optin, optout } = optionalityOf(build())
    expect(optin).toBeUndefined()
    expect(optout).toBeUndefined()
  })

  it.each(CONTAINERS)('%s rejects an absent key and an explicit undefined', (_name, build, ok) => {
    const schema = z.object({ a: build() })

    expect(schema.safeParse({}).success).toBe(false)
    expect(schema.safeParse({ a: undefined }).success).toBe(false)
    // A valid control prevents rejection-only implementations passing.
    expect(schema.safeParse({ a: ok })).toMatchObject({ success: true })
  })

  it.each(CONTAINERS)(
    '%s stays fatal on an absent key even if zod marks it optional-in',
    (_name, build) => {
      const container = build()
      // Both optin and optout must be optional to suppress absence.
      optionalityOf(container).optin = 'optional'

      expect(z.object({ a: container }).safeParse({}).success).toBe(false)
    }
  )
})
