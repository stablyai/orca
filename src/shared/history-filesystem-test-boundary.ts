import { join } from 'node:path'
import type * as HistoryFilesystem from '../../native/history-filesystem'

/** Observes/injects external native IO; successful operations always execute the actual addon. */
export function observeHistoryFilesystem(
  binding: typeof HistoryFilesystem,
  before: (operation: string, parent: string, args: readonly unknown[]) => void
): () => void {
  const open = binding.openDirectory
  const originals = new WeakMap<object, HistoryFilesystem.HistoryDirectory>()
  const wrap = (
    directory: HistoryFilesystem.HistoryDirectory,
    path: string
  ): HistoryFilesystem.HistoryDirectory => {
    const proxy = new Proxy(directory, {
      get(target, key) {
        const member = Reflect.get(target, key)
        if (typeof member !== 'function') {
          return member
        }
        return (...args: unknown[]) => {
          before(String(key), path, args)
          const unwrapped = args.map((arg) =>
            arg !== null && typeof arg === 'object' ? (originals.get(arg) ?? arg) : arg
          )
          const result = Reflect.apply(member, target, unwrapped)
          return key === 'open' && typeof args[0] === 'string'
            ? wrap(result, join(path, args[0]))
            : result
        }
      }
    })
    originals.set(proxy, directory)
    return proxy
  }
  binding.openDirectory = (path, follow) => wrap(open(path, follow), path)
  return () => {
    binding.openDirectory = open
  }
}
