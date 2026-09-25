import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import { nextReceivedSessionTabsFrame } from './web-session-tabs-sync/state'

/**
 * A list's answer, carrying the identity of the request that produced it.
 *
 * A joiner never runs `load`, so anything it needs to rank the answer has to travel with the answer:
 * minting a fresh receipt position for a response that was reserved before the join would let a
 * pre-close list out-rank the retraction that overtook it.
 */
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
  // Why: one runtime snapshot answers every pane in the worktree, so split-pane
  // reconnects should share the same in-flight inventory RPC.
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
    // Why: a post-operation absence proof cannot join an inventory request that
    // began before the operation committed.
    await current.catch(() => undefined)
  }
  return listRemoteRuntimeSessionTabsDeduped(args)
}

export function getRemoteRuntimeSessionTabsInFlightCountForTests(): number {
  return inFlightBySession.size
}
