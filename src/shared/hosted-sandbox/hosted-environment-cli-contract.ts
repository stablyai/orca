// Runtime RPC between `orca cloud env ...` and the desktop that holds the Orca Cloud session.
import type { OrcaCloudEnvironmentResult } from './hosted-environment-api'
import type {
  HostedEnvironmentBuildView,
  HostedEnvironmentStaleness,
  HostedEnvironmentView
} from './hosted-environment-wire'

export const CLOUD_ENVIRONMENT_METHODS = {
  show: 'cloudEnvironment.show',
  setInstallScript: 'cloudEnvironment.setInstallScript',
  startBuild: 'cloudEnvironment.startBuild',
  builds: 'cloudEnvironment.builds',
  followBuild: 'cloudEnvironment.followBuild'
} as const

export type CloudEnvironmentRef = { id: string; name: string }

export type CloudEnvironmentShowData = {
  environment: HostedEnvironmentView
  activeBuild: HostedEnvironmentBuildView | null
  latestBuild: HostedEnvironmentBuildView | null
  staleness: HostedEnvironmentStaleness | null
  canAdmin: boolean
  /** Every environment in the org, so a caller can pass `--env`. */
  environments: CloudEnvironmentRef[]
}

export type CloudEnvironmentBuildsData = {
  environment: CloudEnvironmentRef
  builds: HostedEnvironmentBuildView[]
}

export type CloudEnvironmentStartBuildData = {
  environment: CloudEnvironmentRef
  build: HostedEnvironmentBuildView
}

export type CloudEnvironmentSetInstallScriptData = {
  environment: HostedEnvironmentView
}

export type CloudEnvironmentFollowData = {
  environment: CloudEnvironmentRef
  build: HostedEnvironmentBuildView | null
  chunks: { stream: 'stdout' | 'stderr'; data: string }[]
  cursor: number
  truncated: boolean
  done: boolean
  error: string | null
}

export type CloudEnvironmentRpcResult<T> = OrcaCloudEnvironmentResult<T>
