import { translate } from '@/i18n/i18n'

export function linkedReviewBranchExistsTitle(): string {
  return translate(
    'auto.components.rightSidebar.sourceControl.linkedReviewBranchExists',
    'Linked review branch already exists'
  )
}

export function publishBranchToOriginTitle(): string {
  return translate(
    'auto.components.rightSidebar.sourceControl.publishBranchToOrigin',
    'Publish this branch to origin'
  )
}

export function commitChangesFirstTitle(): string {
  return translate(
    'auto.components.rightSidebar.sourceControl.commitChangesFirst',
    'Commit changes first'
  )
}

export function checkoutBranchFirstTitle(): string {
  return translate(
    'auto.components.rightSidebar.sourceControl.checkoutBranchFirst',
    'Check out a branch first'
  )
}

export function pushFirstTitle(): string {
  return translate('auto.components.rightSidebar.sourceControl.pushFirst', 'Push first')
}

export function forcePushFirstTitle(): string {
  return translate('auto.components.rightSidebar.sourceControl.forcePushFirst', 'Force Push first')
}

export function syncFirstTitle(): string {
  return translate('auto.components.rightSidebar.sourceControl.syncFirst', 'Sync first')
}

export function authRequiredInEnvironmentTitle(instruction: string): string {
  return translate(
    'auto.components.rightSidebar.sourceControl.authRequiredInEnvironment',
    '{{instruction}} in this environment',
    { instruction }
  )
}

export function unsupportedProviderTitle(): string {
  return translate(
    'auto.components.rightSidebar.sourceControl.unsupportedProvider',
    'Unsupported provider'
  )
}

export function reviewAlreadyExistsTitle(reviewLabel: string): string {
  return translate(
    'auto.components.rightSidebar.sourceControl.reviewAlreadyExists',
    'A {{reviewLabel}} already exists',
    { reviewLabel }
  )
}

export function forkHeadUnsupportedTitle(): string {
  return translate(
    'auto.components.rightSidebar.sourceControl.forkHeadUnsupported',
    'Fork head unsupported'
  )
}

export function baseBranchNotOnRemoteTitle(): string {
  return translate(
    'auto.components.rightSidebar.sourceControl.baseBranchNotOnRemote',
    'Base branch is not on the remote'
  )
}

export function branchNotReadyTitle(): string {
  return translate(
    'auto.components.rightSidebar.sourceControl.branchNotReady',
    'Branch is not ready'
  )
}

export function createReviewForBranchTitle(reviewLabel: string): string {
  return translate(
    'auto.components.rightSidebar.sourceControl.createReviewForBranch',
    'Create a {{reviewLabel}} for this branch',
    { reviewLabel }
  )
}

export function forcePushBeforeCreateReviewTitle(reviewLabel: string): string {
  return translate(
    'auto.components.rightSidebar.sourceControl.forcePushBeforeCreateReview',
    'Force push with lease before creating a {{reviewLabel}}',
    { reviewLabel }
  )
}

export function pushBeforeCreateReviewTitle(reviewLabel: string): string {
  return translate(
    'auto.components.rightSidebar.sourceControl.pushBeforeCreateReview',
    'Push local commits before creating a {{reviewLabel}}',
    { reviewLabel }
  )
}

export function operationInProgressTitle(): string {
  return translate(
    'auto.components.rightSidebar.sourceControl.operationInProgress',
    'Operation in progress…'
  )
}

export function abortConflictInProgressTitle(operation: string): string {
  return translate(
    'auto.components.rightSidebar.sourceControl.abortConflictInProgress',
    'Abort the {{operation}} in progress',
    { operation }
  )
}
