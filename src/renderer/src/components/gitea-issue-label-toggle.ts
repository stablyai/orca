import type { GiteaLabel } from '../../../shared/types'

// Resolves the label IDs currently on an issue for the meta editor's toggle.
// Prefers the IDs Gitea reported for the issue so labels missing from the capped
// / org-excluded repo label list survive Gitea's replace-all label update.
// Falls back to resolving IDs by name from the repo labels only when the issue's
// own IDs aren't available yet (the issue detail is still loading) (#5493).
export function resolveAppliedLabelIds(
  appliedLabelIds: number[],
  appliedLabelNames: string[],
  repoLabels: GiteaLabel[]
): number[] {
  if (appliedLabelIds.length > 0) {
    return appliedLabelIds
  }
  const names = new Set(appliedLabelNames)
  return repoLabels.filter((label) => names.has(label.name)).map((label) => label.id)
}

// Adds or removes a single label ID, returning the full ID list to send. The
// toggle is a delta on the actual applied IDs, so unrelated labels are never
// dropped from the set.
export function toggleLabelId(appliedLabelIds: number[], labelId: number): number[] {
  const next = new Set(appliedLabelIds)
  if (next.has(labelId)) {
    next.delete(labelId)
  } else {
    next.add(labelId)
  }
  return [...next]
}
