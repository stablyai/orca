import { useAppStore } from '@/store'
import type { DiffNavigationCommand } from '../editor/combined-diff/scroll-viewport/combined-diff-viewport-anchor'
export type DiffCommentScrollCommand = DiffNavigationCommand & {
  consume(consumed?: (id: string) => void): void
}

export function consumeDiffCommentScrollCommand(expectedId: string): void {
  const state = useAppStore.getState()
  if (state.scrollToDiffCommentId === expectedId) {
    state.setScrollToDiffCommentId(null)
  }
}

export function createDiffCommentScrollCommand(
  id: string,
  releaseAttempt: () => void
): DiffCommentScrollCommand {
  let active = true
  let release: (() => void) | undefined = releaseAttempt
  const releaseNative = (): void => {
    const callback = release
    release = undefined
    callback?.()
  }
  const isCurrent = (): boolean => active && useAppStore.getState().scrollToDiffCommentId === id
  const dispose = (): void => {
    active = false
    unsubscribe()
    releaseNative()
  }
  const unsubscribe = useAppStore.subscribe((state) => {
    if (state.scrollToDiffCommentId !== id) {
      dispose()
    }
  })
  return {
    key: id,
    isCurrent,
    release: releaseNative,
    dispose,
    cancel: () => {
      const current = isCurrent()
      dispose()
      if (current) {
        consumeDiffCommentScrollCommand(id)
      }
    },
    consume: (consumed) => {
      if (!isCurrent()) {
        return
      }
      dispose()
      if (consumed) {
        consumed(id)
      } else {
        consumeDiffCommentScrollCommand(id)
      }
    }
  }
}
