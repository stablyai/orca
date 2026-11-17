// Renderer-local names for the org-environment wire types (control-plane contract lives in shared).
import type {
  HostedEnvironmentBuildStatus,
  HostedEnvironmentBuildStep
} from '../../../../shared/hosted-sandbox/hosted-environment-wire'
import type {
  HostedEnvironmentBuildView,
  HostedEnvironmentStaleness,
  HostedEnvironmentView,
  OrcaCloudEnvironmentError,
  OrcaCloudEnvironmentResult,
  OrcaCloudEnvironmentsApi,
  OrcaCloudRepoSetupImports
} from '../../../../shared/hosted-sandbox/hosted-environment-api'

export type EnvironmentView = HostedEnvironmentView
export type EnvironmentBuildView = HostedEnvironmentBuildView
export type EnvironmentStaleness = HostedEnvironmentStaleness
export type EnvironmentBuildStatus = HostedEnvironmentBuildStatus
export type EnvironmentBuildStep = HostedEnvironmentBuildStep
export type EnvironmentApiError = OrcaCloudEnvironmentError
export type EnvironmentResult<T> = OrcaCloudEnvironmentResult<T>
export type EnvironmentsApi = OrcaCloudEnvironmentsApi
export type RepoSetupImports = OrcaCloudRepoSetupImports
type EnvironmentMachineSize = EnvironmentView['machineSize']

/** What the form edits; `repos[].url` may be `owner/repo` until the control plane canonicalises it. */
export type EnvironmentDraft = {
  name: string
  repos: { url: string; defaultBranch: string | null }[]
  installScript: string
  envVarNames: string[]
  machineSize: EnvironmentMachineSize
}
