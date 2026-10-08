import type { GitHubRepositoryIdentity } from './pull-request-types'

export const ACTIONS_ARTIFACT_MAX_BYTES = 64 * 1024 * 1024
export const ACTIONS_ARTIFACT_HOST_TIMEOUT_MS = 5 * 60_000
export const ACTIONS_ARTIFACT_CLIENT_TIMEOUT_MS = ACTIONS_ARTIFACT_HOST_TIMEOUT_MS + 30_000
export const ACTIONS_ARTIFACT_TIMEOUT_MESSAGE =
  'Timed out downloading the artifact. Retry or download it on GitHub.'
export const ACTIONS_ARTIFACT_CHUNK_BYTES = 256 * 1024
export type ActionsArtifact = {
  id: number
  name: string
  sizeBytes: number
  expired: boolean
  createdAt: string | null
  expiresAt: string | null
}
export type ActionsArtifactsQuery = {
  repository: GitHubRepositoryIdentity
  runId: number
  page?: number
}
export type ActionsArtifactDownloadQuery = {
  repository: GitHubRepositoryIdentity
  runId: number
  artifactId: number
}
export type ActionsArtifactTransferQuery = { transferId: string; offset?: number }
export type ActionsArtifactTransfer = { transferId: string; sizeBytes: number; fileName: string }
export type ActionsArtifactChunk = { contentBase64: string; nextOffset: number; done: boolean }
