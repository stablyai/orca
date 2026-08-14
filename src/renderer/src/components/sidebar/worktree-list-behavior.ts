const recordKeyCountCache = new WeakMap<Record<string, unknown>, number>()

export function countRecordKeysByReference(record: Record<string, unknown>): number {
  const cached = recordKeyCountCache.get(record)
  if (cached !== undefined) {
    return cached
  }
  const count = Object.keys(record).length
  recordKeyCountCache.set(record, count)
  return count
}

export function shouldAdjustWorktreeSidebarMeasuredRowScroll(args: {
  isScrolling: boolean
  now: number
  suppressUntil: number
}): boolean {
  return !args.isScrolling && args.now >= args.suppressUntil
}

export function resolvePendingSidebarReveal(args: {
  targetIndex: number
  targetWorktreeStillExists: boolean
}): 'scroll-and-clear' | 'clear' | 'keep-pending' {
  if (args.targetIndex !== -1) {
    return 'scroll-and-clear'
  }
  return args.targetWorktreeStillExists ? 'keep-pending' : 'clear'
}

export function installWorktreeVisibleRefreshVisibilityListener(onChange: () => void): () => void {
  document.addEventListener('visibilitychange', onChange)
  return () => document.removeEventListener('visibilitychange', onChange)
}
