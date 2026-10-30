import { expect } from './orca-app'
import { readRestartRendererState } from './orca-restart'
import type { PairedElectronClient } from './paired-electron-client'

export async function refreshAuthorityRuntimeId(
  client: PairedElectronClient
): Promise<string | null> {
  return readRestartRendererState(() =>
    client.page.evaluate(async (environmentId) => {
      await window.api.runtimeEnvironments.connect({ selector: environmentId })
      await window.__store?.getState().refreshRuntimeEnvironmentStatus(environmentId)
      return (
        window.__store?.getState().runtimeStatusByEnvironmentId.get(environmentId)?.status
          ?.runtimeId ?? null
      )
    }, client.environmentId)
  )
}

/** Pending null until a live id that is not `previousRuntimeId`; a destroyed renderer is a miss. */
export async function readRelaunchedRuntimeId(
  client: PairedElectronClient,
  previousRuntimeId: string
): Promise<string | null> {
  const current = await refreshAuthorityRuntimeId(client)
  // Why: `expect(null).toEqual(expect.not.stringMatching(prev))` passes; null must stay pending.
  if (current == null || current === previousRuntimeId) {
    return null
  }
  return current
}

/** Waits until the client talks to a new runtime process, not the one it paired to. */
export async function waitForRelaunchedRuntime(
  client: PairedElectronClient,
  previousRuntimeId: string
): Promise<void> {
  await expect
    .poll(() => readRelaunchedRuntimeId(client, previousRuntimeId), {
      timeout: 180_000,
      message: 'paired client never reconnected to a relaunched runtime process'
    })
    .not.toBeNull()
}
