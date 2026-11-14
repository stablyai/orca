import type { SshTarget, SshTargetSummary } from '../../../../../shared/ssh-types'
import { sanitizeSshTargetGeneration } from '../../../../../shared/ssh-target-generation'

export function sshTargetLabelsEqual(
  labels: Map<string, string>,
  targets: Pick<SshTarget, 'id' | 'label'>[]
): boolean {
  if (labels.size !== targets.length) {
    return false
  }
  return targets.every((target) => labels.get(target.id) === target.label)
}

/** Keep only sanitized registration generations; never guess absent values, which would fence against a nonexistent registration. */
export function collectSshTargetGenerations(targets: SshTargetSummary[]): Map<string, number> {
  const generations = new Map<string, number>()
  for (const target of targets) {
    const generation = sanitizeSshTargetGeneration(target.generation)
    if (generation !== undefined) {
      generations.set(target.id, generation)
    }
  }
  return generations
}

export function sshTargetGenerationsEqual(
  current: Map<string, number>,
  next: Map<string, number>
): boolean {
  return (
    current.size === next.size &&
    [...next].every(([targetId, generation]) => current.get(targetId) === generation)
  )
}
