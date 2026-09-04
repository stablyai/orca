import { DEFAULT_REPO_BADGE_COLOR, REPO_COLORS } from './constants'
import type { Worktree } from './worktree/types'
import { getWorktreeHostIdentity } from './worktree/host-qualified-identity'
import { normalizeHexColor } from './hex-color'

/** Assignable swatches, sharing the repo palette so one color language runs across the app.
 *  Neutral is excluded: as a filled swatch it reads as a gray tag rather than as absence, so
 *  "no tag" gets its own empty affordance instead of borrowing a color. */
export const WORKSPACE_COLOR_TAG_SWATCHES: readonly string[] = REPO_COLORS.filter(
  (color) => color !== DEFAULT_REPO_BADGE_COLOR
)

/** Null means "no tag". Any value that is not a hex color clears it. */
export function normalizeWorkspaceColorTag(value: unknown): string | null {
  return normalizeHexColor(value)
}

export function isPresetWorkspaceColorTag(value: unknown): boolean {
  const hex = normalizeWorkspaceColorTag(value)
  return hex !== null && WORKSPACE_COLOR_TAG_SWATCHES.includes(hex)
}

/** Picking the tag a workspace already carries removes it, so one swatch both sets and clears. */
export function resolveWorkspaceColorTagSelection(
  current: string | null,
  chosen: string | null
): string | null {
  const normalizedChosen = normalizeWorkspaceColorTag(chosen)
  return normalizedChosen !== null && normalizedChosen === normalizeWorkspaceColorTag(current)
    ? null
    : normalizedChosen
}

/** The tag a whole selection carries, or null when it is mixed or untagged. Toggle-off must key
 *  off the selection as a whole: keying off the right-clicked workspace alone would clear a mixed
 *  selection when the user meant to unify it. */
export function getSharedWorkspaceColorTag(
  colorTags: readonly (string | null | undefined)[]
): string | null {
  if (colorTags.length === 0) {
    return null
  }
  const first = normalizeWorkspaceColorTag(colorTags[0])
  return colorTags.every((tag) => normalizeWorkspaceColorTag(tag) === first) ? first : null
}

/** True when the selection carries more than one distinct tag state. A mixed selection is not
 *  "untagged" — no swatch should read as checked — but getSharedWorkspaceColorTag must still
 *  return null for it so picking a color unifies rather than toggles off. */
export function isMixedWorkspaceColorTagSelection(
  colorTags: readonly (string | null | undefined)[]
): boolean {
  return new Set(colorTags.map((tag) => normalizeWorkspaceColorTag(tag))).size > 1
}

/** The key a color tag is previewed and written under. Prefers the canonical identity so two rows
 *  for one nested-SSH worktree published through different paired runtimes stay distinct; before a
 *  row has an identity, the runtime owner separates them; host-qualified identity is the last
 *  resort for rows that predate both. */
export function getWorkspaceColorTagIdentity(
  worktree: Pick<Worktree, 'id' | 'hostId' | 'identity' | 'runtimeOwnerEnvironmentId'>
): string {
  if (worktree.identity?.key) {
    return worktree.identity.key
  }
  const hostIdentity = getWorktreeHostIdentity(worktree)
  // Why serialize: SSH aliases and paths can contain '@', so a separator join is not injective and a
  // direct row whose id ends in "@env-a" would share a key with the row env-a owns.
  return worktree.runtimeOwnerEnvironmentId
    ? JSON.stringify([hostIdentity, worktree.runtimeOwnerEnvironmentId])
    : hostIdentity
}

/** The key the same row had before it gained a canonical identity; readers check both, because a
 *  background refresh can promote a row while a preview or a queued write still uses the old key. */
export function getWorkspaceColorTagFallbackIdentity(
  worktree: Pick<Worktree, 'id' | 'hostId' | 'identity' | 'runtimeOwnerEnvironmentId'>
): string {
  return getWorkspaceColorTagIdentity({ ...worktree, identity: undefined })
}
