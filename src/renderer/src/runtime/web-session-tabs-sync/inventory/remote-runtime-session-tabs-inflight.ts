import {
  captureBrowserInitializationDelivery,
  recordBrowserInitializationReceipt
} from '../tab-projection/browser-initialization-presentation'
import type { RuntimeMobileSessionTabsResult } from '../../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import { abortSignalReason } from '../../../../../shared/concurrency/abort-signal-reason'
import { sharedPromiseSettlementWaiters } from '../../../../../shared/concurrency/promise-settlement-waiters'
import type { RuntimeEnvironmentRegistration } from '../../rpc/environment-revisions/runtime-environment-revision'
import {
  createSharedRuntimeRpcAdmission,
  type SharedRuntimeRpcAdmission
} from '../../rpc/calls/shared-runtime-rpc-admission'
import { nextReceivedSessionTabsFrame } from '../state'

/** Share request identity with joiners. A fresh join-time receipt could rank a pre-close list above the retraction that overtook it; joiners never run load themselves. */
export type RemoteRuntimeSessionTabsAnswer = {
  snapshot: RuntimeMobileSessionTabsResult
  receivedFrame: number
  runtimeId?: string
}

type ChatLinkReadScope = {
  registration: RuntimeEnvironmentRegistration | undefined
  connectionGeneration: number
  timeoutMs: number
}

type SessionTabsRead = {
  request: Promise<RemoteRuntimeSessionTabsAnswer>
  receivedFrame: number
  scope?: ChatLinkReadScope
  admission?: SharedRuntimeRpcAdmission
}

const inFlightBySession = new Map<string, SessionTabsRead>()

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
  const read =
    findSessionTabsRead(key) ??
    startSessionTabsRead(key, (receivedFrame, forget) => {
      const delivery = captureBrowserInitializationDelivery(args.environmentId)
      const request = args
        .load()
        .then(({ snapshot, runtimeId }) => {
          recordBrowserInitializationReceipt(args.environmentId, snapshot, receivedFrame, delivery)
          return { snapshot, receivedFrame, ...(runtimeId ? { runtimeId } : {}) }
        })
        .finally(forget)
      return { request, receivedFrame }
    })
  return read.request
}

export function waitForChatLinkSessionTabs(args: {
  environmentId: string
  worktreeId: string
  scope: ChatLinkReadScope
  minimumReceivedFrame?: number
  signal: AbortSignal
  load: (
    admission: SharedRuntimeRpcAdmission,
    receivedFrame: number
  ) => ReturnType<RemoteRuntimeSessionTabsLoad['load']>
}): Promise<RemoteRuntimeSessionTabsAnswer> {
  const { scope } = args
  // A short, chat-only read must not set the deadline or browser receipt of a full refresh.
  const key = `${remoteRuntimeSessionTabsKey(args)}\u0000chat-link`
  const read =
    findSessionTabsRead(key, scope, args.minimumReceivedFrame) ??
    startSessionTabsRead(key, (receivedFrame, forget) => {
      const admission = createSharedRuntimeRpcAdmission(
        () => sharedPromiseSettlementWaiters(request).waiterCount > 0,
        forget
      )
      // Joiners attach before dispatch starts, and can leave without canceling each other.
      const request: Promise<RemoteRuntimeSessionTabsAnswer> = Promise.resolve()
        .then(async () => {
          admission.check()
          return { ...(await args.load(admission, receivedFrame)), receivedFrame }
        })
        .finally(forget)
      return { request, receivedFrame, scope, admission }
    })
  return sharedPromiseSettlementWaiters(read.request).wait({
    signal: args.signal,
    deferSettled: true,
    createAbortError: () => abortSignalReason(args.signal),
    onAbandon: read.admission?.onAbandon
  })
}

function findSessionTabsRead(
  key: string,
  scope?: ChatLinkReadScope,
  minimumReceivedFrame = 0
): SessionTabsRead | undefined {
  const existing = inFlightBySession.get(key)
  if (
    existing &&
    existing.receivedFrame >= minimumReceivedFrame &&
    existing.scope?.registration === scope?.registration &&
    existing.scope?.connectionGeneration === scope?.connectionGeneration &&
    existing.scope?.timeoutMs === scope?.timeoutMs
  ) {
    return existing
  }
  return undefined
}

function startSessionTabsRead(
  key: string,
  load: (receivedFrame: number, forget: () => void) => SessionTabsRead
): SessionTabsRead {
  const read = load(nextReceivedSessionTabsFrame(), () => {
    if (inFlightBySession.get(key) === read) {
      inFlightBySession.delete(key)
    }
  })
  inFlightBySession.set(key, read)
  return read
}

export async function listRemoteRuntimeSessionTabsAfterCurrentInFlight(
  args: RemoteRuntimeSessionTabsLoad
): Promise<RemoteRuntimeSessionTabsAnswer> {
  const current = inFlightBySession.get(remoteRuntimeSessionTabsKey(args))?.request
  if (current) {
    // Post-operation absence proof must start after commit, never join older inventories.
    await current.catch(() => undefined)
  }
  return listRemoteRuntimeSessionTabsDeduped(args)
}
