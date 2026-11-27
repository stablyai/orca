import { globalRegistry, type ZodType } from 'zod'

const lazyResolvers = new WeakMap<object, () => ZodType>()

/**
 * Defers Zod v4 schema construction until first property access so unused RPC/IPC
 * contracts retain ~64 bytes instead of dozens of live schema/closure/Set objects.
 */
export function lazyZodSchema<T extends ZodType>(factory: () => T): T {
  let materialized: T | undefined
  let maskedInternals: object | undefined
  const resolve = (): T => {
    if (materialized === undefined) {
      materialized = factory()
      // globalRegistry keys `.meta()` entries by schema identity; consumers like
      // z.toJSONSchema traverse the proxy, so mirror the entry under it too.
      const meta = globalRegistry.get(materialized)
      if (meta !== undefined) {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The proxy forwards every ZodType member of the materialized T instance.
        globalRegistry.add(proxy as unknown as T, meta)
      }
    }
    return materialized
  }
  // z.toJSONSchema keys its seen-map by the object it traverses (this proxy), but the
  // classic `_zod.processJSONSchema` closure passes the materialized instance to core
  // processors, which then miss that map and crash. Hiding it makes core processSchema
  // fall back to the identical ctx.processors[def.type] called with the proxy itself.
  const internals = (schema: T): object => {
    if (maskedInternals === undefined) {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: ZodType['_zod'] internals are always a non-null object.
      maskedInternals = new Proxy(schema._zod as unknown as object, {
        get(target, prop) {
          if (prop === 'processJSONSchema') {
            return undefined
          }
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Dynamic Proxy forwarding reads any PropertyKey off the materialized schema's _zod internals.
          return (target as Record<PropertyKey, unknown>)[prop]
        },
        has(target, prop) {
          return prop === 'processJSONSchema' ? false : Reflect.has(target, prop)
        }
      })
    }
    return maskedInternals
  }
  const proxy = new Proxy(
    {},
    {
      get(_target, prop) {
        const schema = resolve()
        if (prop === '_zod') {
          return internals(schema)
        }
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Dynamic Proxy forwarding accesses any PropertyKey on the materialized ZodType instance.
        const value: unknown = (schema as Record<PropertyKey, unknown>)[prop]
        return typeof value === 'function' ? value.bind(schema) : value
      },
      has(_target, prop) {
        return Reflect.has(resolve(), prop)
      },
      ownKeys() {
        return Reflect.ownKeys(resolve())
      },
      getOwnPropertyDescriptor(_target, prop) {
        const descriptor = Reflect.getOwnPropertyDescriptor(resolve(), prop)
        return descriptor ? { ...descriptor, configurable: true } : undefined
      },
      getPrototypeOf() {
        return Reflect.getPrototypeOf(resolve())
      }
    }
  )
  lazyResolvers.set(proxy, resolve)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Proxy forwards every ZodType property, prototype, and method to the materialized T instance.
  return proxy as T
}

export function unwrapLazyZodSchema<T extends ZodType>(schema: T): T {
  const resolve = lazyResolvers.get(schema)
  if (!resolve) {
    return schema
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: lazyResolvers only registers resolve() created for this exact T proxy.
  return resolve() as T
}
