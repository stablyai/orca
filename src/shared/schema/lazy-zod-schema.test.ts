import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { lazyZodSchema, unwrapLazyZodSchema } from './lazy-zod-schema'

describe('lazyZodSchema', () => {
  it('defers factory until first property access', () => {
    let built = 0
    const schema = lazyZodSchema(() => {
      built++
      return z.object({ id: z.string() })
    })
    expect(built).toBe(0)
    expect(schema.parse({ id: 'a' })).toEqual({ id: 'a' })
    schema.parse({ id: 'b' })
    expect(built).toBe(1)
  })

  it('unwraps to the materialized schema', () => {
    const schema = lazyZodSchema(() => z.string())
    const real = unwrapLazyZodSchema(schema)
    expect(real).not.toBe(schema)
    expect(unwrapLazyZodSchema(schema)).toBe(real)
    expect(unwrapLazyZodSchema(real)).toBe(real)
  })

  it('keeps instanceof working through the proxy', () => {
    const schema = lazyZodSchema(() => z.object({ id: z.string() }).optional())
    expect(schema instanceof z.ZodOptional).toBe(true)
  })

  it('supports z.toJSONSchema over wrapper types that re-key the seen map', () => {
    // Regression: classic _zod.processJSONSchema captures the materialized
    // instance, so processors missed the seen entry keyed by the proxy and
    // crashed with "Cannot set properties of undefined (setting 'ref')".
    const wrapped = lazyZodSchema(() => z.string().optional())
    const parent = z.object({
      note: wrapped,
      piped: lazyZodSchema(() => z.string().pipe(z.string()))
    })
    const json = z.toJSONSchema(parent, {
      target: 'draft-2020-12',
      unrepresentable: 'any',
      io: 'input'
    })
    const direct = z.toJSONSchema(
      z.object({ note: z.string().optional(), piped: z.string().pipe(z.string()) }),
      { target: 'draft-2020-12', unrepresentable: 'any', io: 'input' }
    )
    expect(json).toEqual(direct)
  })

  it('mirrors .meta() registry entries onto the proxy for z.toJSONSchema', () => {
    // Regression: globalRegistry keys .meta() by the materialized schema, so a
    // traversal over the proxy dropped the id/$defs and description.
    const wrapped = lazyZodSchema(() =>
      z.strictObject({ key: z.string() }).meta({ id: 'LazyMetaRegression', description: 'desc' })
    )
    const parent = z.object({ settings: z.array(wrapped).optional() })
    const json = z.toJSONSchema(parent, { target: 'draft-2020-12', unrepresentable: 'any' })
    const direct = z.toJSONSchema(
      z.object({
        settings: z
          .array(
            z
              .strictObject({ key: z.string() })
              .meta({ id: 'LazyMetaRegression', description: 'desc' })
          )
          .optional()
      }),
      { target: 'draft-2020-12', unrepresentable: 'any' }
    )
    expect(json).toEqual(direct)
    expect(z.globalRegistry.get(wrapped)).toEqual({ id: 'LazyMetaRegression', description: 'desc' })
  })

  it('parses recursive schemas that reference the proxy through z.lazy', () => {
    type Node = { el: string; children?: Node[] }
    const node: z.ZodType<Node> = lazyZodSchema(() =>
      z.lazy(() => z.object({ el: z.string(), children: z.array(node).optional() }))
    )
    expect(node.parse({ el: 'a', children: [{ el: 'b' }] })).toEqual({
      el: 'a',
      children: [{ el: 'b' }]
    })
  })
})
