import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import { nextReceivedSessionTabsFrame } from './web-session-tabs-sync/state'

/** Share request identity with joiners. A fresh join-time receipt could rank a pre-close list above the retraction that overtook it; joiners never run load themselves. */
export type RemoteRuntimeSessionTabsAnswer = {
  snapshot: RuntimeMobileSessionTabsResult
  receivedFrame: number
  runtimeId?: string
}

const inFlightBySession = new Map<string, Promise<RemoteRuntimeSessionTabsAnswer>>()

type RemoteRuntimeSessionTabsLoad = {
  environmentId: string
  worktreeId: string
  load: () => Promise<{ snapshot: RuntimeMobileSessionTabsResult; runtimeId?: string }>
}

function remoteRuntimeSessionTabsKey(args: { environmentId: string; worktreeId: string }): string {
  return `${args.environmentId}\u0000${args.worktreeId}`
}

export function listRemoteRuntimeSessionTabsDeduped(
  args: RemoteRuntimeSessionTabsLoad
): Promise<RemoteRuntimeSessionTabsAnswer> {
  const key = remoteRuntimeSessionTabsKey(args)
  const existing = inFlightBySession.get(key)
  if (existing) {
    return existing
  }
  const receivedFrame = nextReceivedSessionTabsFrame()
  // One workspace inventory answers every split pane; share reconnects’ in-flight RPC.
  const request = args
    .load()
    .then(({ snapshot, runtimeId }) => ({
      snapshot,
      receivedFrame,
      ...(runtimeId ? { runtimeId } : {})
    }))
    .finally(() => {
      if (inFlightBySession.get(key) === request) {
        inFlightBySession.delete(key)
      }
    })
  inFlightBySession.set(key, request)
  return request
}

export async function listRemoteRuntimeSessionTabsAfterCurrentInFlight(
  args: RemoteRuntimeSessionTabsLoad
): Promise<RemoteRuntimeSessionTabsAnswer> {
  const current = inFlightBySession.get(remoteRuntimeSessionTabsKey(args))
  if (current) {
    // Post-operation absence proof must start after commit, never join older inventories.
    await current.catch(() => undefined)
  }
  return listRemoteRuntimeSessionTabsDeduped(args)
}

export function getRemoteRuntimeSessionTabsInFlightCountForTests(): number {
  return inFlightBySession.size
}
