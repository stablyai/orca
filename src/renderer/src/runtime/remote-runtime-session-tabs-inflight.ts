import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'

const inFlightBySession = new Map<string, Promise<RuntimeMobileSessionTabsResult>>()

export function listRemoteRuntimeSessionTabsDeduped(args: {
  environmentId: string
  worktreeId: string
  load: () => Promise<RuntimeMobileSessionTabsResult>
}): Promise<RuntimeMobileSessionTabsResult> {
  const key = `${args.environmentId}\u0000${args.worktreeId}`
  const existing = inFlightBySession.get(key)
  if (existing) {
    return existing
  }
  // Why: one runtime snapshot answers every pane in the worktree, so split-pane
  // reconnects should share the same in-flight inventory RPC.
  const request = args.load().finally(() => {
    if (inFlightBySession.get(key) === request) {
      inFlightBySession.delete(key)
    }
  })
  inFlightBySession.set(key, request)
  return request
}

export function getRemoteRuntimeSessionTabsInFlightCountForTests(): number {
  return inFlightBySession.size
}
