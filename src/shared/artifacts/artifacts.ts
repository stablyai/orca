/** Maximum UTF-8 bytes accepted for a manually shared artifact. */
export const ARTIFACT_MAX_CONTENT_BYTES = 10 * 1024 * 1024

/** Legacy CLI/SSH envelope cap; those transports still have ~1 MiB control frames. */
export const ARTIFACT_CLI_MAX_RPC_BYTES = 800 * 1024

/** Allows JSON escaping while staying below the cloud API's 11 MiB body budget. */
export const ARTIFACT_MAX_REQUEST_BYTES = 11 * 1024 * 1024

/** RPC error code for an artifact API 429; `data` carries the reset time and limit. */
export const ARTIFACT_RATE_LIMITED_CODE = 'artifact_rate_limited'

/** Per-request budget for one call to the artifact cloud API. */
export const ARTIFACT_CLOUD_REQUEST_TIMEOUT_MS = 20_000

/** A 429 asking for a longer wait fails fast; a longer hold would block the file's publish queue. */
export const ARTIFACT_RATE_LIMIT_MAX_RETRY_DELAY_SECONDS = 60

/** Most artifact API requests one share can send: create, its rate-limit replay and the
 * follow-up update, then create and update again after a 401 session refresh. */
export const ARTIFACT_MAX_CLOUD_REQUESTS_PER_OPERATION = 5

/** One session refresh request (CLOUD_REFRESH_TIMEOUT_MS): the expiry refresh before the
 * operation and the 401 refresh during it. The refresh's own 5xx/lost-response replay is
 * cloud-auth's failure path and is not counted. */
const ARTIFACT_SESSION_REFRESH_BUDGET_MS = 20_000

/** Covers a share's worst case: every request it can send, the operation's single
 * rate-limit wait, and both session refreshes. */
export const ARTIFACT_CLI_REQUEST_TIMEOUT_MS =
  ARTIFACT_MAX_CLOUD_REQUESTS_PER_OPERATION * ARTIFACT_CLOUD_REQUEST_TIMEOUT_MS +
  ARTIFACT_RATE_LIMIT_MAX_RETRY_DELAY_SECONDS * 1000 +
  2 * ARTIFACT_SESSION_REFRESH_BUDGET_MS +
  10_000

export function artifactContentByteLength(content: string): number {
  return new TextEncoder().encode(content).byteLength
}

export function artifactWriteRequestByteLength(request: ArtifactWriteRequest): number {
  return new TextEncoder().encode(JSON.stringify(request)).byteLength
}

export type ArtifactMetadata = {
  version: 1
  slug: string
  title: string | null
  originalFileName: string | null
  sourceContentType: string
  renderedContentType: 'text/html'
  createdAt: string
  updatedAt: string
  expiresAt: string
  byteSize: number
  deletedAt: string | null
}

export type ArtifactListItem = {
  artifact: ArtifactMetadata
  shareUrl: string
}

export type ArtifactListPage = {
  artifacts: readonly ArtifactListItem[]
  nextCursor?: string
}

export type ArtifactWriteRequest = {
  sourceKey: string
  content: string
  contentType: 'text/html' | 'text/markdown'
  fileName: string
  title?: string
  apiUrl?: string
  authToken?: string
}

export type ArtifactPublishResult = {
  change: 'created' | 'updated'
  item: ArtifactListItem
}

export type ArtifactPublishedLink = {
  shareUrl: string
}

export type ArtifactCloudOptions = {
  apiUrl?: string
  authToken?: string
}

export type ArtifactListOptions = ArtifactCloudOptions & {
  cursor?: string
}

export type ArtifactCloudOperation<T> =
  | { status: 'ok'; value: T }
  | { status: 'reconnect-required' }
  | { status: 'unconfigured'; message: string }
