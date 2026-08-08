import type { BrowserTabTarget } from '@/lib/browser-tab-host'
import type {
  createWebRuntimeSessionBrowserTab,
  isWebRuntimeSessionActive
} from '@/runtime/web-runtime-session'
import type { BrowserTab as BrowserTabState } from '../../../../shared/types'

export type BrowserTabEntryOperations = {
  createBrowserTab: (
    worktreeId: string,
    url: string,
    options?: {
      activate?: boolean
      browserRuntimeEnvironmentId?: string | null
      targetGroupId?: string
      title?: string
    }
  ) => BrowserTabState
  createWebRuntimeSessionBrowserTab: typeof createWebRuntimeSessionBrowserTab
  isWebRuntimeSessionActive: typeof isWebRuntimeSessionActive
}

const WORKSPACE_RUNTIME_BROWSER_UNAVAILABLE_MESSAGE = 'Workspace runtime browser is unavailable.'

/** Opens a classified URL on its resolved local or runtime browser target. */
export async function openBrowserTabEntryWithOperations(args: {
  browserTabTarget: BrowserTabTarget
  groupId: string
  operations: BrowserTabEntryOperations
  url: string
  worktreeId: string
}): Promise<void> {
  if (args.browserTabTarget.kind === 'unavailable') {
    throw new Error(WORKSPACE_RUNTIME_BROWSER_UNAVAILABLE_MESSAGE)
  }
  if (args.browserTabTarget.kind === 'runtime') {
    if (!args.operations.isWebRuntimeSessionActive(args.browserTabTarget.runtimeEnvironmentId)) {
      throw new Error(WORKSPACE_RUNTIME_BROWSER_UNAVAILABLE_MESSAGE)
    }
    const created = await args.operations.createWebRuntimeSessionBrowserTab({
      worktreeId: args.worktreeId,
      environmentId: args.browserTabTarget.runtimeEnvironmentId,
      url: args.url,
      targetGroupId: args.groupId
    })
    if (created) {
      return
    }
    // Why: local fallback would violate the selected host and recreate split ownership.
    throw new Error(WORKSPACE_RUNTIME_BROWSER_UNAVAILABLE_MESSAGE)
  }
  args.operations.createBrowserTab(args.worktreeId, args.url, {
    activate: true,
    browserRuntimeEnvironmentId: null,
    targetGroupId: args.groupId,
    title: args.url
  })
}
