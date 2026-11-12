// Wire contract for the control plane's GitHub routes used by cloud-start onboarding
// (cloud/apps/sandbox-control/src/github-repo-access.ts). The Worker's tests parse with these.
import { z } from 'zod'

/**
 * GET /v1/github/repo-access?repo=: can Orca Cloud clone this repository for the account?
 * `requested`: an owner of the org on GitHub has been asked to approve the App (D2).
 */
export const HostedGithubRepoAccessResponseSchema = z.object({
  access: z.enum(['public', 'granted', 'missing', 'requested']),
  owner: z.string(),
  repo: z.string().url(),
  installUrl: z.string().url().optional()
})
export type HostedGithubRepoAccessResponse = z.infer<typeof HostedGithubRepoAccessResponseSchema>

/** GET /v1/github/repositories[?cursor=]: repositories the account's GitHub installations reach. */
export const HostedGithubRepositoriesResponseSchema = z.object({
  repositories: z.array(
    z.object({
      id: z.number().int(),
      fullName: z.string(),
      url: z.string().url(),
      owner: z.string(),
      private: z.boolean(),
      defaultBranch: z.string().nullable(),
      pushedAt: z.string().nullable(),
      installationId: z.number().int()
    })
  ),
  nextCursor: z.string().nullable()
})
export type HostedGithubRepositoriesResponse = z.infer<
  typeof HostedGithubRepositoriesResponseSchema
>

/**
 * GET/DELETE /v1/github/user: whether the person (not the account) connected their own GitHub,
 * so cloud commits and pushes carry their name instead of Orca Cloud's.
 */
export const HostedGithubUserResponseSchema = z.union([
  z.object({
    connected: z.literal(true),
    login: z.string().min(1),
    githubUserId: z.number().int()
  }),
  z.object({ connected: z.literal(false) })
])
export type HostedGithubUser = z.infer<typeof HostedGithubUserResponseSchema>

/** POST /v1/github/user/connect: the GitHub OAuth page that binds the person's GitHub identity. */
export const HostedGithubUserConnectResponseSchema = z.object({
  authorizeUrl: z.string().url()
})
