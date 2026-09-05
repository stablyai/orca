/* Absence must stay fatal for the salvaging containers. Both are a bare `z.unknown().transform`,
 * and zod's handlePropertyResult only swallows a missing object key's issues when the field is
 * optional-in *and* optional-out — neither of which a transform sets. That is the whole reason a
 * foreign payload missing `tabsByWorktree` is rejected instead of silently salvaged into an empty
 * session, and until now it was only a comment. Pin it here so a zod release that starts
 * propagating optionality through transforms, or a stray `.optional()`/`.default()` on a container,
 * fails CI instead of quietly widening the accept set of every persisted field. */
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

describe('salvaging containers used bare in an object shape', () => {
  it.each(CONTAINERS)('%s is neither optional-in nor optional-out', (_name, build) => {
    const { optin, optout } = optionalityOf(build())
    expect(optin).toBeUndefined()
    expect(optout).toBeUndefined()
  })

  it.each(CONTAINERS)('%s rejects an absent key and an explicit undefined', (_name, build, ok) => {
    const shape = z.object({ a: build() })

    expect(shape.safeParse({}).success).toBe(false)
    expect(shape.safeParse({ a: undefined }).success).toBe(false)
    // Why: a positive control, so the two rejections above cannot pass by rejecting everything.
    expect(shape.safeParse({ a: ok })).toMatchObject({ success: true })
  })

  it.each(CONTAINERS)(
    '%s stays fatal on an absent key even if zod marks it optional-in',
    (_name, build) => {
      const container = build()
      // Suppression needs optout === 'optional' too, so half the ladder is not enough to widen this.
      optionalityOf(container).optin = 'optional'

      expect(z.object({ a: container }).safeParse({}).success).toBe(false)
    }
  )
})
