import type { SshTarget } from '../../../../shared/ssh-types'
import { isSshConfigSourcedTarget } from '../../../../shared/ssh-target-source'

export type SshTargetGroupId = 'ssh-config' | 'manual'

export type SshTargetGroup = { id: SshTargetGroupId; targets: SshTarget[] }

export const SSH_TARGET_FILTER_THRESHOLD = 8

/** Config-synced hosts first; a legacy target without `source` is grouped by config sync's rule. */
export function groupSshTargetsBySource(targets: readonly SshTarget[]): SshTargetGroup[] {
  const fromConfig = targets.filter((target) => isSshConfigSourcedTarget(target))
  const manual = targets.filter((target) => !isSshConfigSourcedTarget(target))
  const groups: SshTargetGroup[] = [
    { id: 'ssh-config', targets: fromConfig },
    { id: 'manual', targets: manual }
  ]
  return groups.filter((group) => group.targets.length > 0)
}

/** Shift-click ranges must follow grouped display order. */
export function sshTargetDisplayOrder(targets: readonly SshTarget[]): string[] {
  return groupSshTargetsBySource(targets).flatMap((group) => group.targets.map((t) => t.id))
}

export function countSshTargetsBySource(
  targets: readonly SshTarget[]
): Record<SshTargetGroupId, number> {
  const groups = groupSshTargetsBySource(targets)
  return {
    'ssh-config': groups.find((group) => group.id === 'ssh-config')?.targets.length ?? 0,
    manual: groups.find((group) => group.id === 'manual')?.targets.length ?? 0
  }
}

export function filterSshTargets(targets: readonly SshTarget[], query: string): SshTarget[] {
  const needle = query.trim().toLowerCase()
  if (!needle) {
    return [...targets]
  }
  return targets.filter((target) =>
    [target.label, target.host, target.username, target.configHost]
      .filter((value): value is string => typeof value === 'string')
      .some((value) => value.toLowerCase().includes(needle))
  )
}

/** Shift-click applies the clicked row’s new state across the visible anchored range. */
export function applySshTargetSelectionClick(args: {
  selected: ReadonlySet<string>
  orderedIds: readonly string[]
  anchorId: string | null
  clickedId: string
  shiftKey: boolean
}): Set<string> {
  const next = new Set(args.selected)
  const select = !args.selected.has(args.clickedId)
  const anchorIndex = args.anchorId ? args.orderedIds.indexOf(args.anchorId) : -1
  const clickedIndex = args.orderedIds.indexOf(args.clickedId)
  const range =
    args.shiftKey && anchorIndex !== -1 && clickedIndex !== -1
      ? args.orderedIds.slice(
          Math.min(anchorIndex, clickedIndex),
          Math.max(anchorIndex, clickedIndex) + 1
        )
      : [args.clickedId]
  for (const id of range) {
    if (select) {
      next.add(id)
    } else {
      next.delete(id)
    }
  }
  return next
}

export function sshTargetGroupCheckState(
  selected: ReadonlySet<string>,
  ids: readonly string[]
): boolean | 'indeterminate' {
  const count = ids.filter((id) => selected.has(id)).length
  if (count === 0) {
    return false
  }
  return count === ids.length ? true : 'indeterminate'
}

export type SshBulkRemoveSkipReason = 'managed-server' | 'workspaces'

export type SshBulkRemovePlan = {
  removable: SshTarget[]
  skipped: { target: SshTarget; reason: SshBulkRemoveSkipReason }[]
}

/** Skip hosts needing their own managed-server/workspace decision; bulk confirmation cannot decide it. */
export function planSshBulkRemove(
  targets: readonly SshTarget[],
  classify: (target: SshTarget) => SshBulkRemoveSkipReason | null
): SshBulkRemovePlan {
  const plan: SshBulkRemovePlan = { removable: [], skipped: [] }
  for (const target of targets) {
    const reason = classify(target)
    if (reason) {
      plan.skipped.push({ target, reason })
    } else {
      plan.removable.push(target)
    }
  }
  return plan
}

export function sshIdentityFileName(identityFile: string | undefined): string | null {
  const trimmed = identityFile?.trim()
  if (!trimmed) {
    return null
  }
  const parts = trimmed.split(/[\\/]/)
  return parts.at(-1) || trimmed
}
