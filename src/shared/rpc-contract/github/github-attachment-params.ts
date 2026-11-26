import { z } from 'zod'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'
import { RepoWithGitHubTarget, SlugRepo } from './github-repo-target-params'

export const GitHubAttachmentTarget = lazyZodSchema(() =>
  z.discriminatedUnion('kind', [
    RepoWithGitHubTarget.extend({
      kind: z.literal('repo'),
      source: z.enum(['issue', 'origin']),
      worktree: z.string().optional()
    }),
    SlugRepo.extend({ kind: z.literal('slug'), wakeWslDistro: z.boolean().optional() })
  ])
)
export type GitHubAttachmentTarget = z.infer<typeof GitHubAttachmentTarget>
export const UploadGitHubAttachment = lazyZodSchema(() =>
  z.object({
    uploadId: z.string().min(1),
    target: GitHubAttachmentTarget,
    fileName: z.string().min(1).max(255),
    contentType: z.string().min(1).max(100)
  })
)
