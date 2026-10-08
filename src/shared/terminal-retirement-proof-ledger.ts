import type { RuntimeMobileSessionRetiredTerminalSurface } from './runtime-session-contracts'

/** Bound shared by the host's stored list and a client's retained copy of it. */
export const MAX_RETIRED_TERMINAL_SURFACE_PROOFS = 64

type SurfaceTab = { type: string; parentTabId?: string; leafId?: string }

const surfaceKey = (surface: { parentTabId: string; leafId: string }): string =>
  `${surface.parentTabId}\0${surface.leafId}`

export const retirementProofKey = (proof: RuntimeMobileSessionRetiredTerminalSurface): string =>
  `${proof.parentTabId}\0${proof.leafId}\0${proof.terminal}`

/** A surface published again is no longer retired, whatever handle now occupies it. */
export function dropRetirementProofsForLiveSurfaces(
  retired: readonly RuntimeMobileSessionRetiredTerminalSurface[],
  tabs: readonly SurfaceTab[]
): RuntimeMobileSessionRetiredTerminalSurface[] {
  const live = new Set<string>()
  for (const tab of tabs) {
    if (tab.type === 'terminal' && tab.parentTabId !== undefined && tab.leafId !== undefined) {
      live.add(surfaceKey({ parentTabId: tab.parentTabId, leafId: tab.leafId }))
    }
  }
  return retired.filter((surface) => !live.has(surfaceKey(surface)))
}

/** Newest evidence wins per exact identity; the oldest identities fall off past the cap. */
export function appendRetiredTerminalSurfaceProofs(
  existing: readonly RuntimeMobileSessionRetiredTerminalSurface[] | undefined,
  retired: readonly RuntimeMobileSessionRetiredTerminalSurface[]
): RuntimeMobileSessionRetiredTerminalSurface[] {
  const next = new Map((existing ?? []).map((surface) => [retirementProofKey(surface), surface]))
  for (const evidence of retired) {
    const key = retirementProofKey(evidence)
    next.delete(key)
    next.set(key, evidence)
  }
  while (next.size > MAX_RETIRED_TERMINAL_SURFACE_PROOFS) {
    const oldest = next.keys().next().value
    if (typeof oldest !== 'string') {
      break
    }
    next.delete(oldest)
  }
  return [...next.values()]
}
