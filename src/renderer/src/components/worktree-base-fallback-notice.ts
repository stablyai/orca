import type { WorktreeCreateBaseFallback } from '../../../shared/worktree/create-types'

const notices: WorktreeCreateBaseFallback[] = []
const listeners = new Set<() => void>()

function notifyListeners(): void {
  for (const listener of listeners) {
    listener()
  }
}

export function requestWorktreeBaseFallbackNotice(notice: WorktreeCreateBaseFallback): void {
  notices.push(notice)
  notifyListeners()
}

export function dismissWorktreeBaseFallbackNotice(): void {
  if (notices.shift()) {
    notifyListeners()
  }
}

export function getWorktreeBaseFallbackNotice(): WorktreeCreateBaseFallback | null {
  return notices[0] ?? null
}

export function subscribeWorktreeBaseFallbackNotice(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function resetWorktreeBaseFallbackNoticesForTests(): void {
  notices.length = 0
  notifyListeners()
}
