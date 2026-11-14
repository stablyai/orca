import { z } from 'zod'
import { RepoSelector, SlugRepo } from './github-repo-target-params'
export const ActionsArtifactsQuery = z.object({
  repository: SlugRepo,
  runId: z.number().int().positive(),
  page: z.number().int().min(1).max(10).optional()
})
export const ActionsArtifactDownloadQuery = z.object({
  repository: SlugRepo,
  runId: z.number().int().positive(),
  artifactId: z.number().int().positive()
})
export const ActionsArtifactTransferQuery = z.object({
  transferId: z.string().uuid(),
  offset: z.number().int().min(0).optional()
})
export const ActionsArtifacts = RepoSelector.merge(ActionsArtifactsQuery)
export const ActionsArtifactDownload = RepoSelector.merge(ActionsArtifactDownloadQuery)
export const ActionsArtifactTransfer = RepoSelector.merge(ActionsArtifactTransferQuery)
