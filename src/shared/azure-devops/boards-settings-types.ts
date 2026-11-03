/** What the Azure DevOps task views remember, kept out of the max-lines-limited settings module. */
export type AzureDevOpsBoardsSettings = {
  /** Azure DevOps team per project, keyed by `"<organization>/<project>"`; null = project default team. */
  azureDevOpsTeamSelection: Record<string, string> | null
  /** Chosen Tasks view (`workItems`, `backlog` or `board`) keyed by `"<org>/<project>::<team>::<level>"`. */
  azureDevOpsViewSelection: Record<string, string> | null
  /** Local backlog column width overrides (px) keyed by `"<org>/<project>::<team>::<level>"`, then by field reference name. */
  azureDevOpsBacklogColumnWidths: Record<string, Record<string, number>> | null
}
