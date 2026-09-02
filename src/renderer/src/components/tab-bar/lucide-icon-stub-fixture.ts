// Why a proxy over a fixed list: the omnibox reaches sidebar modules through tab
// activation, so which icons the graph pulls in is not knowable per test file.

export function stubEveryIcon(): Record<string, unknown> {
  const Icon = (): null => null
  const isIconKey = (key: string | symbol): boolean => typeof key === 'string' && key !== 'then'
  return new Proxy({} as Record<string, unknown>, {
    get: (_target, key) => (isIconKey(key) ? Icon : undefined),
    has: (_target, key) => isIconKey(key)
  })
}
