import { noopUnsubscribe } from './web-storage'

export function withFallback<T extends object>(target: T, path: string[]): T {
  return new Proxy(target, {
    get(current, property, receiver) {
      if (property in current) {
        const value = Reflect.get(current, property, receiver) as unknown
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          return withFallback(value as object, [...path, String(property)])
        }
        return value
      }
      return createFallbackProxy([...path, String(property)])
    }
  })
}

export function createFallbackProxy(
  path: string[],
  applyOverride?: (path: string[], args: unknown[]) => unknown
): never {
  const fn = () => undefined
  return new Proxy(fn, {
    get(_target, property) {
      if (property === 'then') {
        return undefined
      }
      return createFallbackProxy([...path, String(property)], applyOverride)
    },
    apply(_target, _thisArg, args) {
      if (applyOverride) {
        return applyOverride(path, args)
      }
      return getFallbackResult(path, args)
    }
  }) as never
}

export function getFallbackResult(path: string[], args: unknown[]): unknown {
  const name = path.at(-1) ?? ''
  if (name.startsWith('on')) {
    return noopUnsubscribe
  }
  if (name.startsWith('is') || name.startsWith('has') || name === 'pathExists') {
    return Promise.resolve(false)
  }
  if (name.startsWith('list') || name.startsWith('detect')) {
    return Promise.resolve([])
  }
  if (name.startsWith('preview')) {
    return Promise.resolve({ found: false, diff: {}, unsupportedKeys: [] })
  }
  if (name.startsWith('get') && name.endsWith('Status')) {
    return Promise.resolve([])
  }
  if (name === 'write' || name === 'resize' || name === 'reportGeometry') {
    return undefined
  }
  if (args.length === 0 && (name === 'getZoomLevel' || name === 'declarePendingPaneSerializer')) {
    return 0
  }
  return Promise.resolve(undefined)
}
