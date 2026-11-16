import type { AddRepoExistingWorkspaceSource } from '../../../../shared/telemetry/schemas/telemetry-property-schemas'
import type { GlobalSettings } from '../../../../shared/settings/global-settings-types'
import type { WslHostAddResult } from '../../../../shared/remote-runtime/wsl-hosts/wsl-host-types'

export type WslHostOffer = {
  path: string
  distro: string
  source: AddRepoExistingWorkspaceSource
}

export type WslHostOfferDeps = {
  /** The setting before Accept, restored when the host add fails. */
  readWslHostsSetting: () => boolean
  updateSettings: (updates: Partial<GlobalSettings>) => Promise<void>
  addWslHost: (args: { distro: string; startIfStopped: boolean }) => Promise<WslHostAddResult>
  addLocalPath: (path: string, source: AddRepoExistingWorkspaceSource) => Promise<unknown>
  /** Moves the project just added onto the host, and only it: Stage 1 never moves the others. */
  moveAddedProject: (offer: WslHostOffer) => void
}

/**
 * Turns WSL hosts on and adds the distro as a host; an already-added distro counts as added.
 * Restores the setting and returns the refusal when the add fails.
 */
export async function runWslDistroAsHost(
  distro: string,
  deps: Pick<WslHostOfferDeps, 'readWslHostsSetting' | 'updateSettings' | 'addWslHost'>
): Promise<Extract<WslHostAddResult, { ok: false }> | null> {
  const previous = deps.readWslHostsSetting()
  // Left on after a failure, a later "Add on this computer" would still be auto-moved.
  const restore = (): Promise<void> => deps.updateSettings({ experimentalWslHosts: previous })
  let result: WslHostAddResult
  try {
    await deps.updateSettings({ experimentalWslHosts: true })
    // Accepting is the user's ask to run this distro, so a stopped one may start.
    result = await deps.addWslHost({ distro, startIfStopped: true })
  } catch (cause) {
    await restore()
    throw cause
  }
  if (!result.ok && result.kind !== 'already-added') {
    await restore()
    return result
  }
  return null
}

/**
 * Turns WSL hosts on, adds the distro, adds the project as before, then moves that one project
 * onto the host. The distro's other bridge projects stay put. Returns the refusal when the add fails.
 */
export async function acceptWslHostOffer(
  offer: WslHostOffer,
  deps: WslHostOfferDeps
): Promise<Extract<WslHostAddResult, { ok: false }> | null> {
  const refusal = await runWslDistroAsHost(offer.distro, deps)
  if (refusal) {
    return refusal
  }
  await deps.addLocalPath(offer.path, offer.source)
  deps.moveAddedProject(offer)
  return null
}

/** Adds the project as before, and never offers again. */
export async function declineWslHostOffer(
  offer: WslHostOffer,
  deps: Pick<WslHostOfferDeps, 'updateSettings' | 'addLocalPath'>
): Promise<void> {
  await deps.updateSettings({ wslHostOfferDismissed: true })
  await deps.addLocalPath(offer.path, offer.source)
}
