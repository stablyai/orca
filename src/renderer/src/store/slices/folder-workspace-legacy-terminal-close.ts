import { FOLDER_WORKSPACE_BACKEND_TEARDOWN_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import { mapWithConcurrency } from '../../../../shared/map-with-concurrency'
import { callRuntimeRpc, runtimeEnvironmentSupportsCapability } from '@/runtime/runtime-rpc-client'

const LEGACY_TERMINAL_CLOSE_CONCURRENCY = 4

export type FolderWorkspaceRuntimeTerminalRemoval = {
  environmentId: string
  expectedEnvironmentPairingRevision?: number
  terminalHandles: string[]
}

export async function isLegacyRuntimeFolderWorkspaceDeletionBlocked(
  removal: FolderWorkspaceRuntimeTerminalRemoval | null
): Promise<boolean> {
  if (!removal) {
    return false
  }
  return !(await runtimeEnvironmentSupportsCapability(
    removal.environmentId,
    FOLDER_WORKSPACE_BACKEND_TEARDOWN_RUNTIME_CAPABILITY,
    {
      timeoutMs: 15_000,
      expectedEnvironmentPairingRevision: removal.expectedEnvironmentPairingRevision
    }
  ))
}

export async function closeFolderWorkspaceRuntimeTerminalHandles(
  removal: FolderWorkspaceRuntimeTerminalRemoval
): Promise<number> {
  const results = await mapWithConcurrency(
    removal.terminalHandles,
    LEGACY_TERMINAL_CLOSE_CONCURRENCY,
    async (terminal) => {
      try {
        await callRuntimeRpc(
          { kind: 'environment', environmentId: removal.environmentId },
          'terminal.close',
          { terminal },
          {
            timeoutMs: 15_000,
            expectedEnvironmentPairingRevision: removal.expectedEnvironmentPairingRevision
          }
        )
        return true
      } catch {
        return false
      }
    }
  )
  return results.filter((closed) => !closed).length
}

export async function closeLegacyRuntimeCatalogTerminals(
  removal: FolderWorkspaceRuntimeTerminalRemoval | null,
  backendTeardownByEnvironment: Map<string, Promise<boolean>>,
  isCurrent: () => boolean
): Promise<void> {
  if (!removal || !isCurrent()) {
    return
  }
  const capabilityKey = `${removal.environmentId}\0${removal.expectedEnvironmentPairingRevision ?? ''}`
  let backendOwnsTeardown = backendTeardownByEnvironment.get(capabilityKey)
  if (!backendOwnsTeardown) {
    backendOwnsTeardown = runtimeEnvironmentSupportsCapability(
      removal.environmentId,
      FOLDER_WORKSPACE_BACKEND_TEARDOWN_RUNTIME_CAPABILITY,
      {
        timeoutMs: 15_000,
        expectedEnvironmentPairingRevision: removal.expectedEnvironmentPairingRevision
      }
    ).catch((error) => {
      console.warn('Failed to check deleted folder workspace terminal teardown support:', error)
      return false
    })
    backendTeardownByEnvironment.set(capabilityKey, backendOwnsTeardown)
  }
  if ((await backendOwnsTeardown) || !isCurrent()) {
    return
  }
  const failed = await closeFolderWorkspaceRuntimeTerminalHandles(removal)
  if (failed > 0) {
    console.warn('Failed to close deleted legacy folder workspace terminals:', { failed })
  }
}
