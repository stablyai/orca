// Use a proxy because tab activation reaches sidebar icons beyond each test’s direct imports.

export function stubEveryIcon(): Record<string, unknown> {
  const Icon = (): null => null
  const isIconKey = (key: string | symbol): boolean => typeof key === 'string' && key !== 'then'
  return new Proxy({} as Record<string, unknown>, {
    get: (_target, key) => (isIconKey(key) ? Icon : undefined),
    has: (_target, key) => isIconKey(key)
  })
}
