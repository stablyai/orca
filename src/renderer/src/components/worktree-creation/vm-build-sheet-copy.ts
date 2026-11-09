import type { Translate } from '@/i18n/use-translate'
import type { VmBuildStep } from './vm-build-steps'
import type { WorktreeSetupStepState } from './worktree-setup-steps'

export function stepLabel(step: VmBuildStep, cloud: boolean, t: Translate): string {
  switch (step.id) {
    case 'provision':
      return cloud
        ? t('auto.components.worktree.creation.VmBuildSheet.provisionCloud', 'Start sandbox')
        : t('auto.components.worktree.creation.VmBuildSheet.provision', 'Provision VM')
    case 'checks':
      return cloud
        ? t('auto.components.worktree.creation.VmBuildSheet.checksCloud', 'Prepare environment')
        : t('auto.components.worktree.creation.VmBuildSheet.checks', 'Check environment')
    case 'create':
      return cloud
        ? t('auto.components.worktree.creation.VmBuildSheet.createCloud', 'Open workspace')
        : t('auto.components.worktree.creation.VmBuildSheet.create', 'Create workspace')
  }
}

export type SheetState = 'building' | 'ready' | 'attention' | 'failed'

export function headerTitle(
  state: SheetState,
  cloud: boolean,
  t: Translate,
  /** The machine came up and only opening the workspace on it failed. */
  openFailed = false
): string {
  if (cloud) {
    switch (state) {
      case 'building':
        return t(
          'auto.components.worktree.creation.VmBuildSheet.titleCloud',
          'Starting your cloud workspace'
        )
      case 'ready':
        return t(
          'auto.components.worktree.creation.VmBuildSheet.readyCloud',
          'Your cloud workspace is ready'
        )
      case 'attention':
        return t(
          'auto.components.worktree.creation.VmBuildSheet.attentionCloud',
          'Your cloud workspace needs attention'
        )
      case 'failed':
        if (openFailed) {
          return t(
            'auto.components.worktree.creation.VmBuildSheet.openFailedCloud',
            'Couldn’t open your cloud workspace'
          )
        }
        return t(
          'auto.components.worktree.creation.VmBuildSheet.failedCloud',
          'Couldn’t start your cloud workspace'
        )
    }
  }
  switch (state) {
    case 'building':
      return t(
        'auto.components.worktree.creation.VmBuildSheet.titleVm',
        'Building your VM workspace'
      )
    case 'ready':
      return t(
        'auto.components.worktree.creation.VmBuildSheet.readyVm',
        'Your VM workspace is ready'
      )
    case 'attention':
      return t(
        'auto.components.worktree.creation.VmBuildSheet.attentionVm',
        'Your VM workspace needs attention'
      )
    case 'failed':
      return t(
        'auto.components.worktree.creation.VmBuildSheet.failedVm',
        'Couldn’t build your VM workspace'
      )
  }
}

/** Screen-reader text for a step's icon, which carries its state visually. */
export function stepStateLabel(state: WorktreeSetupStepState, t: Translate): string {
  switch (state) {
    case 'pending':
      return t('auto.components.worktree.creation.VmBuildSheet.statePending', 'Not started')
    case 'running':
      return t('auto.components.worktree.creation.VmBuildSheet.stateRunning', 'In progress')
    case 'done':
      return t('auto.components.worktree.creation.VmBuildSheet.stateDone', 'Done')
    case 'failed':
      return t('auto.components.worktree.creation.VmBuildSheet.stateFailed', 'Failed')
  }
}
