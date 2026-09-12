import type { FolderWorkspace } from './folder-workspace-types'
import type { Repo } from './repo-types'
import type { SavedPortForward, SshRemotePtyLease, SshTarget } from './ssh-types'

export type OrcadMigrationBlockerCategory =
  | 'registration'
  | 'exclusive-ownership'
  | 'drainable-static-state'
  | 'live-or-unverifiable'
  | 'client-owned-state'

export const ORCAD_MIGRATION_DEPENDENCY_KINDS = [
  'saved-port-forward',
  'terminal-lease',
  'terminal-recovery',
  'workspace-session',
  'worktree-metadata',
  'worktree-lineage',
  'workspace-lineage',
  'sparse-preset',
  'retired-worktree-name',
  'automation',
  'automation-run',
  'mobile-tab-selection',
  'ui-routing'
] as const

export type OrcadMigrationDependencyKind = (typeof ORCAD_MIGRATION_DEPENDENCY_KINDS)[number]

export type OrcadMigrationDependency = {
  kind: OrcadMigrationDependencyKind
  count: number
}

export type OrcadMigrationRepository = Pick<Repo, 'id' | 'path' | 'displayName' | 'kind'>
export type OrcadMigrationFolderWorkspace = Pick<FolderWorkspace, 'id' | 'name' | 'folderPath'>
export type OrcadMigrationTerminalLease = Pick<
  SshRemotePtyLease,
  'ptyId' | 'worktreeId' | 'tabId' | 'leafId' | 'state' | 'updatedAt'
>

export type OrcadMigrationBlocker =
  | {
      code: 'orcad_migration_target_not_found'
      category: 'registration'
    }
  | {
      code: 'orcad_migration_target_owned'
      category: 'exclusive-ownership'
      owner: NonNullable<SshTarget['owner']>
    }
  | {
      code: 'orcad_migration_direct_ssh_repositories'
      category: 'drainable-static-state'
      repositories: OrcadMigrationRepository[]
    }
  | {
      code: 'orcad_migration_direct_ssh_folder_workspaces'
      category: 'drainable-static-state'
      folderWorkspaces: OrcadMigrationFolderWorkspace[]
    }
  | {
      code: 'orcad_migration_direct_ssh_terminal_leases'
      category: 'live-or-unverifiable'
      terminalLeases: OrcadMigrationTerminalLease[]
    }
  | {
      code: 'orcad_migration_saved_port_forwards'
      category: 'client-owned-state'
      portForwards: SavedPortForward[]
    }
  | {
      code: 'orcad_migration_dependent_state'
      category: 'client-owned-state'
      dependencies: OrcadMigrationDependency[]
    }

export type OrcadMigrationPreflight = {
  targetId: string
  targetLabel: string | null
  claimable: boolean
  blockers: OrcadMigrationBlocker[]
}
