/** Exact repo ownership changes made while re-adopting a removed SSH host. */
export type SshRepoReadoption = {
  oldTargetId: string
  newTargetId: string
  repoIds: string[]
}
