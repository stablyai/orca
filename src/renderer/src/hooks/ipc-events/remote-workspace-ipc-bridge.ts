import { useAppStore } from '../../store'
import type { DirectSshBridgeRuntime } from './direct-ssh-bridge-runtime'

export function registerRemoteWorkspaceIpcBridge(
  unsubs: (() => void)[],
  runtime: DirectSshBridgeRuntime
): void {
  let clientId: string | null = null
  let clientIdPromise: Promise<string | null> | null = null
  const getClientId = (): Promise<string | null> => {
    const remoteWorkspace = window.api.remoteWorkspace
    if (!remoteWorkspace) {
      return Promise.resolve(null)
    }
    if (clientId) {
      return Promise.resolve(clientId)
    }
    clientIdPromise ??= remoteWorkspace
      .clientId()
      .then((id) => {
        clientId = id
        return id
      })
      .catch(() => null)
    return clientIdPromise
  }
  if (!window.api.remoteWorkspace) {
    return
  }
  void getClientId()
  unsubs.push(
    window.api.remoteWorkspace.onChanged((event) => {
      void (async () => {
        const currentClientId = await getClientId()
        if (event.sourceClientId && currentClientId && event.sourceClientId === currentClientId) {
          return
        }
        await runtime.remoteWorkspaceTargetSync
          ?.applyUnsolicitedSnapshot(event.targetId, event.snapshot)
          .catch((error) => {
            useAppStore.getState().setRemoteWorkspaceSyncStatus(event.targetId, {
              phase: 'error',
              revision: event.snapshot.revision,
              message: error instanceof Error ? error.message : 'Failed to apply remote workspace'
            })
          })
      })()
    })
  )
}
