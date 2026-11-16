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

type WslHostAddRefusal = Extract<WslHostAddResult, { ok: false }>

// One run per distro, joined by every caller (add-project offer, chat refusals).
const runningByDistro = new Map<string, Promise<WslHostAddRefusal | null>>()
const runningListeners = new Set<() => void>()
// Runs in flight share the setting: the first records it, the last restores it if none added.
let batch: { active: number; previous: boolean; added: boolean } | null = null
let restoring: Promise<void> = Promise.resolve()

function notifyRunning(): void {
  for (const listener of runningListeners) {
    listener()
  }
}

export function subscribeWslDistroHostRuns(listener: () => void): () => void {
  runningListeners.add(listener)
  return () => runningListeners.delete(listener)
}

/** The distro's run in flight from any caller; undefined when none. */
export function runningWslDistroAsHost(
  distro: string
): Promise<WslHostAddRefusal | null> | undefined {
  return runningByDistro.get(distro.toLowerCase())
}

/**
 * Turns WSL hosts on and adds the distro as a host; an already-added distro counts as added.
 * Returns the refusal when the add fails. A call while the same distro runs joins that run;
 * other distros run alongside it, and the setting goes back only once every run failed.
 */
export function runWslDistroAsHost(
  distro: string,
  deps: Pick<WslHostOfferDeps, 'readWslHostsSetting' | 'updateSettings' | 'addWslHost'>
): Promise<WslHostAddRefusal | null> {
  const key = distro.toLowerCase()
  const running = runningByDistro.get(key)
  if (running) {
    return running
  }
  const run = addDistroAsHost(distro, deps).finally(() => {
    runningByDistro.delete(key)
    notifyRunning()
  })
  runningByDistro.set(key, run)
  notifyRunning()
  return run
}

async function addDistroAsHost(
  distro: string,
  deps: Pick<WslHostOfferDeps, 'readWslHostsSetting' | 'updateSettings' | 'addWslHost'>
): Promise<WslHostAddRefusal | null> {
  if (!batch) {
    // Read the setting only after the last batch put it back.
    await restoring
  }
  batch ??= { active: 0, previous: deps.readWslHostsSetting(), added: false }
  const current = batch
  current.active += 1
  try {
    await deps.updateSettings({ experimentalWslHosts: true })
    // Accepting is the user's ask to run this distro, so a stopped one may start.
    const result = await deps.addWslHost({ distro, startIfStopped: true })
    if (result.ok || result.kind === 'already-added') {
      current.added = true
      return null
    }
    return result
  } finally {
    current.active -= 1
    if (current.active === 0) {
      batch = null
      // Left on after a failure, a later "Add on this computer" would still be auto-moved.
      if (!current.added) {
        const restore = deps.updateSettings({ experimentalWslHosts: current.previous })
        restoring = restore.catch(() => undefined)
        await restore
      }
    }
  }
}

/**
 * Turns WSL hosts on, adds the distro, adds the project as before, then moves that one project
 * onto the host. The distro's other bridge projects stay put. Returns the refusal when the add fails.
 */
export async function acceptWslHostOffer(
  offer: WslHostOffer,
  deps: WslHostOfferDeps
): Promise<WslHostAddRefusal | null> {
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
