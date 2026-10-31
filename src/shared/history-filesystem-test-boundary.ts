import { join } from 'node:path'
import type * as HistoryFilesystem from '../../native/history-filesystem'

type HistoryDirectory = HistoryFilesystem.HistoryDirectory

/** Observes/injects external native IO; a boolean returned for `same`/`sameDevice` stands in for its answer. */
export function observeHistoryFilesystem(
  binding: typeof HistoryFilesystem,
  before: (operation: string, parent: string, args: readonly unknown[]) => void | boolean
): () => void {
  const open = binding.openDirectory
  const originals = new WeakMap<HistoryDirectory, HistoryDirectory>()
  const unwrap = (directory: HistoryDirectory): HistoryDirectory =>
    originals.get(directory) ?? directory
  const wrap = (directory: HistoryDirectory, path: string): HistoryDirectory => {
    const observe = <T>(operation: string, args: unknown[], run: () => T): T => {
      before(operation, path, args)
      return run()
    }
    const predicate = (operation: string, other: HistoryDirectory, run: () => boolean) => {
      const injected = before(operation, path, [other])
      return typeof injected === 'boolean' ? injected : run()
    }
    const wrapper: HistoryDirectory = {
      entries: () => observe('entries', [], () => directory.entries()),
      kind: (name) => observe('kind', [name], () => directory.kind(name)),
      open: (name) => observe('open', [name], () => wrap(directory.open(name), join(path, name))),
      mkdir: (name, like) =>
        observe('mkdir', [name, like], () => directory.mkdir(name, like && unwrap(like))),
      move: (name, destination, target, directoryOnly) =>
        observe('move', [name, destination, target, directoryOnly], () =>
          directory.move(name, unwrap(destination), target, directoryOnly)
        ),
      link: (name, target) => observe('link', [name, target], () => directory.link(name, target)),
      readLink: (name) => observe('readLink', [name], () => directory.readLink(name)),
      removeEmpty: (name) => observe('removeEmpty', [name], () => directory.removeEmpty(name)),
      read: (name) => observe('read', [name], () => directory.read(name)),
      write: (name, data, create) =>
        observe('write', [name, data, create], () => directory.write(name, data, create)),
      unlink: (name) => observe('unlink', [name], () => directory.unlink(name)),
      identity: (name) => observe('identity', [name], () => directory.identity(name)),
      same: (other) => predicate('same', other, () => directory.same(unwrap(other))),
      sameDevice: (other) =>
        predicate('sameDevice', other, () => directory.sameDevice(unwrap(other))),
      close: () => observe('close', [], () => directory.close())
    }
    originals.set(wrapper, directory)
    return wrapper
  }
  binding.openDirectory = (path, follow) => wrap(open(path, follow), path)
  return () => {
    binding.openDirectory = open
  }
}
