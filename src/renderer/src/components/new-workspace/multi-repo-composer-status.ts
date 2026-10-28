import { translate } from '@/i18n/i18n'
import type { SelectedProjectResolution } from './resolve-project-setup-for-host'

export function countBlockedProjects(resolutions: readonly SelectedProjectResolution[]): number {
  return resolutions.filter((entry) => entry.resolution.status === 'unavailable').length
}

/** Text beside a disabled Create; null when the selection can be sent. */
export function getMultiRepoCreateBlockedReason(blockedCount: number): string | null {
  if (blockedCount > 0) {
    return blockedCount === 1
      ? translate(
          'auto.components.newWorkspace.multiRepo.blockedOne',
          'Remove 1 project or switch host'
        )
      : translate(
          'auto.components.newWorkspace.multiRepo.blockedMany',
          'Remove {{n}} projects or switch host',
          { n: blockedCount }
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
    'Create in {{n}} projects',
    {
      n: projectCount
    }
  )
}

/** Helper line under the name field: the branch rule, or how many projects differ. */
export function getMultiRepoBranchHelper(
  name: string,
  projectCount: number,
  overrideCount: number
): string {
  if (overrideCount === 1) {
    return translate(
      'auto.components.newWorkspace.multiRepo.branchDiffersOne',
      'Branch differs in 1 project'
    )
  }
  if (overrideCount > 1) {
    return translate(
      'auto.components.newWorkspace.multiRepo.branchDiffers',
      'Branch differs in {{n}} projects',
      { n: overrideCount }
    )
  }
  return translate(
    'auto.components.newWorkspace.multiRepo.branchInAll',
    'Branch {{name}} in all {{n}} projects',
    { name: name.trim(), n: projectCount }
  )
}
