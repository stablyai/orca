/** What a GitHub-only Orca Cloud create starts from. */
export type GitHubCreateSource = {
  repoUrl: string
  /** `owner/repo`. */
  fullName: string
  /**
   * The composer's name field: the workspace's title, never the agent's prompt.
   */
  name: string
  /** The project the composer had selected, for Back to draft. */
  composerRepoId: string
}
