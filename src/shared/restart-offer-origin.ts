import type { Worktree } from './worktree/types'
import { workspaceCreatorRelation } from './workspace-creator-provenance'

/**
 * Whose interrupted chat a restart offer is, from the asking device's side, decided per WORKSPACE
 * by the same rule the sidebar uses for "workspaces from other devices". Only `own` is ticked by
 * default, announced, or continued without asking.
 */
export const RESTART_OFFER_ORIGINS = ['own', 'other-device', 'automation', 'server-made'] as const

export type RestartOfferOrigin = (typeof RESTART_OFFER_ORIGINS)[number]

export type RestartOfferWorkspaceProvenance = Pick<
  Worktree,
  'creatorProvenance' | 'automationProvenance'
>

/** `viewerDeviceId` null is the host's own user; an unknown workspace has no record, so it is theirs. */
export function restartOfferOrigin(
  workspace: RestartOfferWorkspaceProvenance | undefined,
  viewerDeviceId: string | null
): RestartOfferOrigin {
  if (workspace?.automationProvenance?.kind === 'created-by-automation') {
    return 'automation'
  }
  switch (workspaceCreatorRelation(workspace?.creatorProvenance, viewerDeviceId)) {
    case 'viewer':
      return 'own'
    case 'host':
      return 'server-made'
    case 'other-device':
      return 'other-device'
  }
}

export function parseRestartOfferOrigin(value: unknown): RestartOfferOrigin | undefined {
  return RESTART_OFFER_ORIGINS.find((origin) => origin === value)
}
