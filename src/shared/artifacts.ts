/** Maximum UTF-8 bytes accepted for a manually shared artifact. */
export const ARTIFACT_MAX_CONTENT_BYTES = 10 * 1024 * 1024

/** Legacy CLI/SSH envelope cap; those transports still have ~1 MiB control frames. */
export const ARTIFACT_CLI_MAX_RPC_BYTES = 800 * 1024

/** Allows JSON escaping while staying below the cloud API's 11 MiB body budget. */
export const ARTIFACT_MAX_REQUEST_BYTES = 11 * 1024 * 1024

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
