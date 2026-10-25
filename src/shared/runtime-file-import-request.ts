export type RuntimeFileImportRequest = {
  environmentId: string
  worktree: string
  relativePaths: string[]
  destinationDir: string
  expectedEnvironmentPairingRevision: number
}
