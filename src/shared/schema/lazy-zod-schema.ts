import type { ZodType } from 'zod'

const lazyResolvers = new WeakMap<object, () => ZodType>()

/**
 * Defers Zod v4 schema construction until first property access so unused RPC/IPC
 * contracts retain ~64 bytes instead of dozens of live schema/closure/Set objects.
 */
export function lazyZodSchema<T extends ZodType>(factory: () => T): T {
  let materialized: T | undefined
  const resolve = (): T => {
    if (materialized === undefined) {
      materialized = factory()
    }
    return materialized
  }
  const proxy = new Proxy(
    {},
    {
      get(_target, prop) {
        const schema = resolve()
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
