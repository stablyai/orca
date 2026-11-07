import type { GlobalSettings } from '../../../../../../shared/global-settings-types'
import type { RemoveWorktreeOptions } from '../../worktree-removal-options'

export function resolveWorktreeRemovalPreference(
  settings: GlobalSettings | null,
  force: boolean | undefined,
  options: RemoveWorktreeOptions | undefined
): {
  forgetLocalOnly: boolean
  force: boolean | undefined
  options: RemoveWorktreeOptions | undefined
} {
  const forgetLocalOnly = options?.mode === 'forget-local'
  const alwaysForceDelete = !forgetLocalOnly && settings?.alwaysForceDeleteWorktrees === true
  return {
    forgetLocalOnly,
    force: alwaysForceDelete || force,
    options: alwaysForceDelete ? { ...options, allowUnverifiedPtyStop: true } : options
  }
}
