import type { OrcadManagedStopResult } from '../../../src/shared/orcad-managed-runtime'

export type ConvertedHostTeardown = {
  environmentId: string
  targetId: string
  worktreeId: string
}

/** Runs in the renderer; only this fixture's converted SSH environment can be stopped. */
export async function decommissionConvertedHost({
  environmentId,
  targetId,
  worktreeId
}: ConvertedHostTeardown): Promise<OrcadManagedStopResult> {
  const managedOrcad = window.api.runtimeEnvironments.managedOrcad
  if (!managedOrcad) {
    throw new Error('Converted host teardown requires the desktop managed server API')
  }
  const environments = await window.api.runtimeEnvironments.list()
  const owned = environments.filter(
    (environment) =>
      environment.id === environmentId &&
      environment.orcadDeployment?.kind !== 'wsl' &&
      environment.orcadDeployment?.sshTargetId === targetId
  )
  if (owned.length !== 1) {
    throw new Error('Converted host teardown could not verify its environment and SSH target')
  }
  const closed = await window.api.runtimeEnvironments.call({
    selector: environmentId,
    method: 'terminal.closeAll',
    params: { worktree: `id:${worktreeId}` },
    timeoutMs: 120_000
  })
  const receipt = closed.ok ? closed.result : null
  if (
    !receipt ||
    typeof receipt !== 'object' ||
    !('retiredSurfaces' in receipt) ||
    receipt.retiredSurfaces !== true ||
    ('ptyStopVerdict' in receipt && receipt.ptyStopVerdict !== undefined)
  ) {
    throw new Error(`Converted host terminal stop was not proven: ${JSON.stringify(closed)}`)
  }
  const stopped = await managedOrcad.stop({
    selector: environmentId
  })
  if (
    stopped.outcome !== 'unlinked' ||
    stopped.verdict !== 'exited' ||
    stopped.environmentId !== environmentId ||
    stopped.sshTargetId !== targetId
  ) {
    throw new Error(`Converted host decommission was not proven: ${JSON.stringify(stopped)}`)
  }
  return stopped
}
