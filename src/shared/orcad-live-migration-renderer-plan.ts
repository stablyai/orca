export type OrcadLiveMigrationRendererPlan = {
  version: 1
  migrationId: string
  retirementRecordSha256: string
  sourceSshTargetId: string
  destinationEnvironmentId: string
  destinationRuntimeId: string
  sourceCatalog: {
    repoIds: string[]
    projectGroupIds: string[]
    folderWorkspaceIds: string[]
  }
  workspaces: {
    workspaceId: string
    terminals: {
      tabId: string
      leafId: string
      sourcePtyId: string
      incarnationId: string
    }[]
  }[]
}

export type OrcadLiveMigrationRendererPlanSelection = {
  selector: string
  migrationId: string
}
