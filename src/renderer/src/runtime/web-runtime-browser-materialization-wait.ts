import { useAppStore } from '../store'
import { hasMaterializedWebRuntimeBrowserPage } from './web-runtime-browser-materialization'

const PAGE_MATERIALIZATION_TIMEOUT_MS = 8_000

export function waitForWebRuntimeBrowserPageMaterialization(args: {
  environmentId: string
  worktreeId: string
  remotePageId: string
  expectedGroupId?: string
  /** A frame-drawn workspace's frames took the page over (L284): done, with no handle yet. */
  handedToFrames?: () => boolean
}): Promise<boolean> {
  const hasMaterialized = (state = useAppStore.getState()): boolean =>
    args.handedToFrames?.() === true ||
    hasMaterializedWebRuntimeBrowserPage(
      state,
      args.environmentId,
      args.worktreeId,
      args.remotePageId,
      args.expectedGroupId
    )
  if (hasMaterialized()) {
    return Promise.resolve(true)
  }
  return new Promise((resolve) => {
    let settled = false
    let timeout: ReturnType<typeof setTimeout> | undefined
    let unsubscribe: (() => void) | undefined
    const finish = (materialized: boolean): void => {
      if (settled) {
        return
      }
      settled = true
      if (timeout) {
        clearTimeout(timeout)
      }
      unsubscribe?.()
      resolve(materialized)
    }
    unsubscribe = useAppStore.subscribe((state) => {
      if (hasMaterialized(state)) {
        finish(true)
      }
    })
    if (settled) {
      unsubscribe()
      return
    }
    timeout = setTimeout(() => finish(false), PAGE_MATERIALIZATION_TIMEOUT_MS)
    if (hasMaterialized()) {
      finish(true)
    }
  })
}
