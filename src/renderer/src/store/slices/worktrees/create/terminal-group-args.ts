import type { WorkspaceSource } from '../../../../../../shared/workspace-source'

export type TerminalGroupCreateArgs = {
  repoId: string
  name: string
  telemetrySource?: WorkspaceSource
}
