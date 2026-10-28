export type BitbucketRepositorySummary = {
  fullName: string
  name: string
  isPrivate: boolean
  updatedOn: string | null
  httpsCloneUrl: string | null
  sshCloneUrl: string | null
}

export type BitbucketRepositoryListResult =
  | { ok: true; repositories: BitbucketRepositorySummary[] }
  | { ok: false; reason: 'not-configured' | 'failed' }
