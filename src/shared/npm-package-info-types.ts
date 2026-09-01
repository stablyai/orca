import type { ExecutionHostId } from './execution-host'

/** IPC channel for the single method this domain exposes. */
export const NPM_PACKAGE_INFO_LOOKUP_CHANNEL = 'npm-package-info:lookup'

/**
 * Request/result contract for the `npmPackageInfo` IPC domain, shared by
 * main, preload, and renderer so no side re-derives the shape.
 */
export type NpmPackageInfoRequest = {
  packageName: string
  /** Must be a registered worktree root; the local npm CLI runs with this cwd. */
  worktreeRoot: string
  executionHostId: ExecutionHostId
}

export type NpmPackageInfo = {
  packageName: string
  description: string | null
  latestVersion: string | null
  /** ISO timestamp, from the registry's `time[dist-tags.latest]`. */
  latestPublishedAt: string | null
  /** `https:` only; any other scheme is normalized to `null` before it reaches this type. */
  homepageUrl: string | null
  /** `https:` only; any other scheme is normalized to `null` before it reaches this type. */
  repositoryUrl: string | null
  source: 'npm-cli' | 'registry-http'
}

/**
 * Three distinct failure states are never collapsed into `null`: the renderer
 * (Slice 2) must render "not found", "lookups disabled", and "offline/timed
 * out" as separately messaged outcomes.
 */
export type NpmPackageInfoResult =
  | { status: 'ok'; info: NpmPackageInfo }
  | { status: 'not-found' }
  | { status: 'lookup-disabled' }
  | { status: 'unavailable'; reason: 'timeout' | 'network' | 'host-unresolved' | 'error' }
