import type { RpcDispatcher } from '../../../src/main/runtime/rpc/dispatcher'

async function dispatchSyntheticExitClose(options: {
  dispatcher: RpcDispatcher
  worktreeId: string
  tabId: string
  publicationEpoch: string
  terminal: string
  requestId: string
  connection?: { connectionId: string; pairedDeviceId: string }
}): Promise<void> {
  const { dispatcher, worktreeId, tabId, publicationEpoch, terminal, requestId, connection } =
    options
  const request = {
    id: requestId,
    authToken: 'fixture-only',
    method: 'session.tabs.closeLifecycle',
    params: {
      worktree: `id:${worktreeId}`,
      tabId,
      reason: 'pty-exit',
      publicationEpoch,
      terminal
    }
  }
  const response = connection
    ? await new Promise<Awaited<ReturnType<RpcDispatcher['dispatch']>>>((resolve, reject) => {
        void dispatcher
          .dispatchStreaming(
            request,
            (serialized) =>
              resolve(JSON.parse(serialized) as Awaited<ReturnType<RpcDispatcher['dispatch']>>),
            {
              clientKind: 'runtime',
              connectionId: connection.connectionId,
              pairedDeviceId: connection.pairedDeviceId
            }
          )
          .catch(reject)
      })
    : await dispatcher.dispatch(request)
  if (!response.ok) {
    throw new Error(
      `Synthetic close ${requestId} failed: ${response.error.code}: ${response.error.message} ${JSON.stringify(response.error.data ?? null)}`
    )
  }
  const result = response.result as {
    refused?: unknown
    refusalReason?: unknown
    snapshotRepublished?: unknown
  }
  if (
    result.refused !== true ||
    result.refusalReason !== 'live-host-pty' ||
    result.snapshotRepublished !== true
  ) {
    throw new Error(
      `Synthetic close ${requestId} bypassed live-host adjudication: ${JSON.stringify(result)}`
    )
  }
}

export async function dispatchFixtureCloseBursts(options: {
  dispatcher: RpcDispatcher
  worktreeId: string
  targets: ReadonlyMap<string, { publicationEpoch: string; terminal: string }>
}): Promise<void> {
  const { dispatcher, worktreeId, targets } = options
  const targetEntries = [...targets.entries()]
  await Promise.all(
    targetEntries.map(([tabId, claim], index) =>
      dispatchSyntheticExitClose({
        dispatcher,
        worktreeId,
        tabId,
        ...claim,
        requestId: `desktop-${index}`
      })
    )
  )
  for (const profile of ['a', 'b']) {
    await Promise.all(
      targetEntries.map(([tabId, claim], index) =>
        dispatchSyntheticExitClose({
          dispatcher,
          worktreeId,
          tabId,
          ...claim,
          requestId: `profile-${profile}-${index}`,
          connection: {
            connectionId: `remote-profile-${profile}-generation-1`,
            pairedDeviceId: `fixture-profile-${profile}`
          }
        })
      )
    )
  }
}
