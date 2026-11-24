import {
  captureBrowserInitializationDelivery,
  recordBrowserInitializationReceipt
} from '../tab-projection/browser-initialization-presentation'
import type { RuntimeMobileSessionTabsResult } from '../../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import { waitForPromiseWithSignal } from '../../../../../shared/concurrency/abort-signal-reason'
import { sharedPromiseSettlementWaiters } from '../../../../../shared/concurrency/promise-settlement-waiters'
import type { RuntimeEnvironmentRegistration } from '../../rpc/environment-revisions/runtime-environment-revision'
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

const inFlightBySession = new Map<
  string,
  { request: Promise<RemoteRuntimeSessionTabsAnswer>; receivedFrame: number; scope?: ChatLinkReadScope }
>()

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
  return shareSessionTabsRead(remoteRuntimeSessionTabsKey(args), undefined, (receivedFrame) => {
    const delivery = captureBrowserInitializationDelivery(args.environmentId)
    return args.load().then(({ snapshot, runtimeId }) => {
      recordBrowserInitializationReceipt(args.environmentId, snapshot, receivedFrame, delivery)
      return { snapshot, receivedFrame, ...(runtimeId ? { runtimeId } : {}) }
    })
  })
}

export function waitForChatLinkSessionTabs(args: {
  environmentId: string
  worktreeId: string
  scope: ChatLinkReadScope
  minimumReceivedFrame?: number
  signal: AbortSignal
  load: (hasWaiters: () => boolean) => ReturnType<RemoteRuntimeSessionTabsLoad['load']>
}): Promise<RemoteRuntimeSessionTabsAnswer> {
  const { scope } = args
  // A short, chat-only read must not set the deadline or browser receipt of a full refresh.
  const key = `${remoteRuntimeSessionTabsKey(args)}\u0000chat-link`
  const request: Promise<RemoteRuntimeSessionTabsAnswer> = shareSessionTabsRead(
    key,
    scope,
    async (receivedFrame) => {
      // Joiners attach before dispatch starts, and can leave without canceling each other.
      await Promise.resolve()
      const answer = await args.load(() => sharedPromiseSettlementWaiters(request).waiterCount > 0)
      return { ...answer, receivedFrame }
    },
    args.minimumReceivedFrame
  )
  return waitForPromiseWithSignal(request, args.signal)
}

function shareSessionTabsRead(
  key: string,
  scope: ChatLinkReadScope | undefined,
  load: (receivedFrame: number) => Promise<RemoteRuntimeSessionTabsAnswer>,
  minimumReceivedFrame = 0
): Promise<RemoteRuntimeSessionTabsAnswer> {
  const existing = inFlightBySession.get(key)
  if (
    existing &&
    existing.receivedFrame >= minimumReceivedFrame &&
    existing.scope?.registration === scope?.registration &&
    existing.scope?.connectionGeneration === scope?.connectionGeneration &&
    existing.scope?.timeoutMs === scope?.timeoutMs
  ) {
    return existing.request
  }
  const receivedFrame = nextReceivedSessionTabsFrame()
  const request = load(receivedFrame).finally(() => {
    if (inFlightBySession.get(key)?.request === request) {
      inFlightBySession.delete(key)
    }
  })
  inFlightBySession.set(key, { request, receivedFrame, scope })
  return request
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
