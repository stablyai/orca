import { expect } from './orca-app'
import type { PairedElectronClient } from './paired-electron-client'

export async function assertRuntimeSshStatus(
  client: PairedElectronClient,
  targetId: string,
  expectedStatus: string
): Promise<void> {
  await expect
    .poll(
      () =>
        client.page.evaluate(
          ({ environmentId, targetId }) =>
            window.__store
              ?.getState()
              .sshStateByEnvironment.get(environmentId)
              ?.connectionStates.get(targetId)?.status ?? null,
          { environmentId: client.environmentId, targetId }
        ),
      { timeout: 30_000 }
    )
    .toBe(expectedStatus)
}
