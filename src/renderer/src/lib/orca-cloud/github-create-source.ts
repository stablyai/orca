/** What a GitHub-only Orca Cloud create starts from (D4, GH-CREATE-SHEET). */
export type GitHubCreateSource = {
  repoUrl: string
  /** `owner/repo`. */
  fullName: string
  /**
   * The composer's name field: the workspace's title (NAME-DROPPED), never the agent's prompt
   * (CLOUD-ONLY-NAME-AS-PROMPT).
   */
  name: string
  /** The project the composer had selected, for Back to draft. */
  composerRepoId: string
}
