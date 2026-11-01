import type { AddRepoExistingWorkspaceSource } from '../../../../shared/telemetry-events'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { WslHostAddResult } from '../../../../shared/wsl-host-types'

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
}

/**
 * Turns WSL hosts on, adds the distro, then adds the project as before: opening it is what lets
 * the existing automatic move carry it onto the new host. Returns the refusal when the add fails.
 */
export async function acceptWslHostOffer(
  offer: WslHostOffer,
  deps: WslHostOfferDeps
): Promise<Extract<WslHostAddResult, { ok: false }> | null> {
  const previous = deps.readWslHostsSetting()
  // Left on after a failure, a later "Add on this computer" would still be auto-moved.
  const restore = (): Promise<void> => deps.updateSettings({ experimentalWslHosts: previous })
  let result: WslHostAddResult
  try {
    await deps.updateSettings({ experimentalWslHosts: true })
    // Accepting is the user's ask to run this distro, so a stopped one may start.
    result = await deps.addWslHost({ distro: offer.distro, startIfStopped: true })
  } catch (cause) {
    await restore()
    throw cause
  }
  if (!result.ok && result.kind !== 'already-added') {
    await restore()
    return result
  }
  await deps.addLocalPath(offer.path, offer.source)
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
