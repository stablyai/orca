import React from 'react'
import { OrcaCloudNeedsRepoLine } from '../run-on/OrcaCloudNeedsRepoLine'
import { OrcaCloudDroppedLine } from '../run-on/OrcaCloudDroppedLine'
import { GitHubHandoffLine } from '../run-on/GitHubHandoffLine'
import { ORCA_CLOUD_NEEDS_REPO_ID } from '../run-on/cloud-start-view'
import type { CloudStartView } from '../run-on/use-cloud-start-composer'
import { ORCA_CLOUD_RECIPE_ID } from '../../../../../shared/hosted-sandbox/orca-cloud-recipe-id'
import { cloudAddProjectExtraItems } from '../ProjectComboboxCloudAddProjectEntry'
import type { ProjectComboboxProps } from '../project-combobox-props'
import type { OrcaCloudDropReason } from '@/hooks/composer-state/workspace-target/useEphemeralVmRecipeOptions'
import type { OrcaCloudRunTargetAccess } from '../orca-cloud-run-target-access'
import type RunTargetCombobox from '@/components/new-workspace/run-target/RunTargetCombobox'

type RunTargetProps = Partial<React.ComponentProps<typeof RunTargetCombobox>>

export type ProjectSectionCloudInput = {
  selectedEphemeralVmRecipeId: string | null
  cloudStart: CloudStartView | null
  projectError: string | null | undefined
  projectDescriptionId: string
  onProjectChange: (projectId: string) => void
  onAddProject: () => void
  handleProjectHostSetupChange: (setupId: string) => void
  onEphemeralVmRecipeChange?: (recipeId: string | null) => void
  orcaCloudAvailability: RunTargetProps['orcaCloudAvailability']
  orcaCloudDropped: OrcaCloudDropReason | null
  orcaCloudAccess?: OrcaCloudRunTargetAccess
}

/** Orca Cloud's additions to the composer's Project | Run on row; inert when cloud is not in play. */
export function projectSectionCloud(input: ProjectSectionCloudInput): {
  addProjectExtraItems: ReturnType<typeof cloudAddProjectExtraItems>
  comboboxProps: Partial<ProjectComboboxProps>
  /** The line under Project between its error and its empty-state hint; null for none. */
  projectLine: React.ReactNode
  runTargetProps: RunTargetProps
  /** The line under Run on when there is no recipe error; null for none. */
  runTargetLine: React.ReactNode
} {
  const { cloudStart, projectError, projectDescriptionId } = input
  // Cloud-only rows: while Orca Cloud is picked, and for a folder, which only starts from GitHub.
  const cloudOnly =
    input.selectedEphemeralVmRecipeId === ORCA_CLOUD_RECIPE_ID || cloudStart?.folderProject
      ? cloudStart?.cloudOnly
      : undefined
  // Each stopped Create moves focus to Project (quietly), where the error is.
  const needsRepo = cloudStart?.needsGitHubRepo ?? null
  return {
    // The button beside "Project" gets the same "Orca Cloud" group as the
    // list's Add project row while Run on is Orca Cloud.
    addProjectExtraItems: cloudAddProjectExtraItems(cloudOnly?.moreAccess),
    comboboxProps: {
      onValueChange: (projectId) => {
        cloudOnly?.clear()
        input.onProjectChange(projectId)
      },
      // While Orca Cloud is picked, GitHub repositories with no clone here.
      cloudRepos: cloudOnly?.repos ?? null,
      cloudRepoValue: cloudOnly?.picked?.fullName ?? null,
      onCloudRepoSelected: (fullName) => {
        cloudOnly?.pick(fullName)
        cloudStart?.onSelectOrcaCloud()
      },
      onMoreCloudAccess: cloudOnly?.moreAccess,
      onShowMoreCloudRepos: cloudOnly?.showMore ?? null,
      cloudReposRetry: cloudOnly?.retryRepos
        ? { retry: cloudOnly.retryRepos, retrying: cloudOnly.retryingRepos }
        : null,
      invalid: Boolean(projectError) || Boolean(needsRepo),
      // Waiting for a GitHub repository is a fixable precondition: amber, not red.
      invalidTone: !projectError && needsRepo ? 'warning' : 'error',
      describedBy: !projectError && needsRepo ? ORCA_CLOUD_NEEDS_REPO_ID : projectDescriptionId,
      focusSignal: needsRepo?.attempt ?? 0,
      openSignal: cloudStart?.openRepoPickerSignal ?? 0
    },
    projectLine:
      cloudOnly && cloudOnly.githubHandoff !== 'idle' ? (
        <GitHubHandoffLine
          phase={cloudOnly.githubHandoff}
          onCheckAgain={cloudOnly.checkGitHubAgain}
        />
      ) : needsRepo ? (
        <OrcaCloudNeedsRepoLine
          hasRepos={needsRepo.hasRepos}
          onAddRepository={input.onAddProject}
          unreachable={needsRepo.unreachable === true}
          onMoreAccess={cloudOnly?.moreAccess}
        />
      ) : null,
    runTargetProps: {
      onHostChange: (setupId) => {
        cloudStart?.onUserPick()
        input.handleProjectHostSetupChange(setupId)
      },
      onRecipeChange: (recipeId) => {
        cloudStart?.onUserPick()
        input.onEphemeralVmRecipeChange?.(recipeId)
      },
      orcaCloudAvailability: input.orcaCloudAvailability,
      ...(input.orcaCloudAccess ? { orcaCloudAccess: input.orcaCloudAccess } : {}),
      // Setup happens after Start, on its own page: picking Orca Cloud just picks it.
      ...(cloudStart ? { onSelectOrcaCloud: cloudStart.onSelectOrcaCloud } : {})
    },
    runTargetLine: input.orcaCloudDropped ? (
      <OrcaCloudDroppedLine reason={input.orcaCloudDropped} />
    ) : null
  }
}
