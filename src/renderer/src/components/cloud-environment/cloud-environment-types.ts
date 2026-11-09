// Renderer-local names for the org-environment wire types (control-plane contract lives in shared).
import type {
  HostedEnvironmentBuildStatus,
  HostedEnvironmentBuildStep,
  HostedEnvironmentStalenessRecommendation
} from '../../../../shared/hosted-sandbox/hosted-environment-wire'
import type {
  HostedEnvironmentBuildView,
  HostedEnvironmentListEntry,
  HostedEnvironmentStaleness,
  HostedEnvironmentView,
  OrcaCloudEnvironmentBuildStreamEvent,
  OrcaCloudEnvironmentError,
  OrcaCloudEnvironmentResult,
  OrcaCloudEnvironmentsApi,
  OrcaCloudRepoSetupImports
} from '../../../../shared/hosted-sandbox/hosted-environment-api'

export type EnvironmentView = HostedEnvironmentView
export type EnvironmentBuildView = HostedEnvironmentBuildView
export type EnvironmentListItem = HostedEnvironmentListEntry
export type EnvironmentStaleness = HostedEnvironmentStaleness
export type EnvironmentBuildStatus = HostedEnvironmentBuildStatus
export type EnvironmentBuildStep = HostedEnvironmentBuildStep
export type EnvironmentStalenessRecommendation = HostedEnvironmentStalenessRecommendation
export type EnvironmentBuildEvent = OrcaCloudEnvironmentBuildStreamEvent
export type EnvironmentApiError = OrcaCloudEnvironmentError
export type EnvironmentResult<T> = OrcaCloudEnvironmentResult<T>
export type EnvironmentsApi = OrcaCloudEnvironmentsApi
export type RepoSetupImports = OrcaCloudRepoSetupImports
export type EnvironmentMachineSize = EnvironmentView['machineSize']
export type EnvironmentRepo = EnvironmentView['repos'][number]

/** What the form edits; `repos[].url` may be `owner/repo` until the control plane canonicalises it. */
export type EnvironmentDraft = {
  name: string
  repos: { url: string; defaultBranch: string | null }[]
  installScript: string
  envVarNames: string[]
  machineSize: EnvironmentMachineSize
}
