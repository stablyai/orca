import { useAppStore } from '../store'
import { hasMaterializedWebRuntimeBrowserPage } from './web-runtime-browser-materialization'

const PAGE_MATERIALIZATION_TIMEOUT_MS = 8_000

export function waitForWebRuntimeBrowserPageMaterialization(args: {
  environmentId: string
  worktreeId: string
  remotePageId: string
  expectedGroupId?: string
}): Promise<boolean> {
  const hasMaterialized = (): boolean =>
    hasMaterializedWebRuntimeBrowserPage(
      useAppStore.getState(),
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
      if (
        hasMaterializedWebRuntimeBrowserPage(
          state,
          args.environmentId,
          args.worktreeId,
          args.remotePageId,
          args.expectedGroupId
        )
      ) {
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
