/** What a GitHub-only Orca Cloud create starts from (D4, GH-CREATE-SHEET). */
export type GitHubCreateSource = {
  repoUrl: string
  /** `owner/repo`. */
  fullName: string
  /** The composer's text: the workspace's title and the agent's first prompt. */
  prompt: string
  /** The project the composer had selected, for Back to draft. */
  composerRepoId: string
}
