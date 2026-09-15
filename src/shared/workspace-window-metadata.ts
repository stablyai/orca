export const WORKSPACE_WINDOW_METADATA_CHANNEL = 'ui:set-workspace-window-metadata'

export type WorkspaceWindowMetadata = {
  displayName: string | null
  localPath: string | null
}
