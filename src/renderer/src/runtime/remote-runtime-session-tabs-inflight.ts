import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'

const inFlightBySession = new Map<string, Promise<RuntimeMobileSessionTabsResult>>()

type RemoteRuntimeSessionTabsLoad = {
  environmentId: string
  worktreeId: string
  load: () => Promise<RuntimeMobileSessionTabsResult>
}

function remoteRuntimeSessionTabsKey(args: { environmentId: string; worktreeId: string }): string {
  return `${args.environmentId}\u0000${args.worktreeId}`
}

export function listRemoteRuntimeSessionTabsDeduped(
  args: RemoteRuntimeSessionTabsLoad
): Promise<RuntimeMobileSessionTabsResult> {
  const key = remoteRuntimeSessionTabsKey(args)
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

export async function listRemoteRuntimeSessionTabsAfterCurrentInFlight(
  args: RemoteRuntimeSessionTabsLoad
): Promise<RuntimeMobileSessionTabsResult> {
  const current = inFlightBySession.get(remoteRuntimeSessionTabsKey(args))
  if (current) {
    // Why: a post-operation absence proof cannot join an inventory request that
    // began before the operation committed.
    await current.catch(() => undefined)
  }
  return listRemoteRuntimeSessionTabsDeduped(args)
}

export function getRemoteRuntimeSessionTabsInFlightCountForTests(): number {
  return inFlightBySession.size
}
