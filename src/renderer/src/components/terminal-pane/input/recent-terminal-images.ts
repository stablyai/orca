import type { Terminal } from '@xterm/xterm'
import { isImageDropPath } from '../../../../../shared/terminal/input/image-path-paste'
import { isWindowsAbsolutePathLike } from '../../../../../shared/file-access/cross-platform-path'

export type RecentTerminalImage = {
  path: string
  pasted: boolean
  addedAt: number
}

const EMPTY: readonly RecentTerminalImage[] = []
const entries = new WeakMap<Terminal, readonly RecentTerminalImage[]>()
const listeners = new WeakMap<Terminal, Set<() => void>>()

export function getRecentTerminalImages(terminal: Terminal): readonly RecentTerminalImage[] {
  return entries.get(terminal) ?? EMPTY
}

export function subscribeToRecentTerminalImages(
  terminal: Terminal,
  listener: () => void
): () => void {
  const subscribers = listeners.get(terminal) ?? new Set()
  subscribers.add(listener)
  listeners.set(terminal, subscribers)
  return () => {
    subscribers.delete(listener)
  }
}

export function recordRecentTerminalImage(terminal: Terminal, path: string, pasted = false): void {
  if ((!path.startsWith('/') && !isWindowsAbsolutePathLike(path)) || !isImageDropPath(path)) {
    return
  }
  const previous = getRecentTerminalImages(terminal).filter((image) => image.path !== path)
  entries.set(terminal, [{ path, pasted, addedAt: Date.now() }, ...previous].slice(0, 4))
  listeners.get(terminal)?.forEach((listener) => listener())
}
