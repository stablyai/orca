import { translate } from '@/i18n/i18n'
import type { SelectedProjectResolution } from './resolve-project-setup-for-host'

export function countBlockedProjects(resolutions: readonly SelectedProjectResolution[]): number {
  return resolutions.filter((entry) => entry.resolution.status === 'unavailable').length
}

/** Text beside a disabled Create; null when the selection can be sent. */
export function getMultiRepoCreateBlockedReason(blockedCount: number): string | null {
  if (blockedCount > 0) {
    return translate(
      'auto.components.newWorkspace.multiRepo.blocked',
      'Remove {{count}} projects or switch host',
      { count: blockedCount, defaultValue_one: 'Remove {{count}} project or switch host' }
    )
  }
  return null
}

export function getMultiRepoPrimaryActionLabel(projectCount: number, creating: boolean): string {
  if (creating) {
    return translate('auto.components.newWorkspace.multiRepo.creating', 'Creating…')
  }
  // Counts only projects that can be created; a blocked selection must not promise N repos.
  if (projectCount < 2) {
    return translate(
      'auto.components.NewWorkspaceComposerModal.createWorkspace',
      'Create workspace'
    )
  }
  return translate(
    'auto.components.newWorkspace.multiRepo.createInProjects',
    'Create in {{count}} projects',
    { count: projectCount, defaultValue_one: 'Create in {{count}} project' }
  )
}

/** Helper line under the name field: the branch rule, or how many projects differ. */
export function getMultiRepoBranchHelper(
  name: string,
  projectCount: number,
  overrideCount: number
): string {
  if (overrideCount > 0) {
    return translate(
      'auto.components.newWorkspace.multiRepo.branchDiffers',
      'Branch differs in {{count}} projects',
      { count: overrideCount, defaultValue_one: 'Branch differs in {{count}} project' }
    )
  }
  return translate(
    'auto.components.newWorkspace.multiRepo.branchInAll',
    'Branch {{name}} in all {{count}} projects',
    {
      name: name.trim(),
      count: projectCount,
      defaultValue_one: 'Branch {{name}} in {{count}} project'
    }
  )
}
