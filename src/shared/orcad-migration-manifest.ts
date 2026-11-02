import type { FolderWorkspace } from './folder-workspace-types'
import type { Automation, AutomationRun } from './automations-types'
import type { OrcadMigrationManifestVersion } from './orcad-migration-manifest-validation'
import type { ProjectGroup } from './project-group-types'
import type { Repo } from './repo-types'
import type { SparsePreset } from './worktree/create-types'
import type { WorkspaceLineage, WorktreeLineage } from './worktree/lineage-types'
import type { WorktreeMeta } from './worktree/meta-types'
import type { RetiredNameRegistry } from './worktree/retired-name-registry'
import type { WorkspaceSessionState } from './workspace-session-state-types'
import type { OrcadMigrationClientStatePayload } from './orcad-migration-client-state'
import type {
  OrcadMigrationSnapshotUploadState,
  OrcadMigrationTerminalScrollbackSnapshot
} from './orcad-migration-scrollback'
import type { OrcadMigrationBlobUploadState } from './orcad-migration-blob-transfer'

import { isRecord } from './orcad-migration-manifest-fields'

/** The relay-era SSH source: on the wire it never carries `kind` (see orcad-migration-source-kind). */
export type OrcadMigrationSshManifestSource = {
  sshTargetId: string
  sshTargetGeneration: number | null
  targetLabel: string
}

/**
 * Local WSL projects on this desktop, moving to the orcad that runs inside their distro. Scope is
 * explicit so a destination never infers it from paths, and `generation` orders delta moves.
 */
export type OrcadMigrationLocalWslManifestSource = {
  kind: 'local-wsl'
  distro: string
  /** The distro's registry id, when known: a re-registered distro of the same name is another one. */
  distroGuid?: string
  scopeRepoIds: string[]
  scopeFolderWorkspaceIds: string[]
  generation: number
}

export type OrcadMigrationManifestSource =
  | OrcadMigrationSshManifestSource
  | OrcadMigrationLocalWslManifestSource

export type OrcadMigrationCatalogPayload = {
  repositories: Repo[]
  projectGroups: ProjectGroup[]
  folderWorkspaces: FolderWorkspace[]
  dormantState?: OrcadMigrationDormantStatePayload
}

export type OrcadMigrationDormantWorktreeMeta = {
  sourceKey: string
  worktreeId: string
  meta: WorktreeMeta
}

export type OrcadMigrationDormantWorktreeLineage = {
  sourceKey: string
  worktreeId: string
  lineage: WorktreeLineage
}

export type OrcadMigrationDormantWorkspaceLineage = {
  sourceKey: string
  childWorkspaceKey: string
  lineage: WorkspaceLineage
}

export type OrcadMigrationDormantRetiredNames = {
  repoId: string
  registry: RetiredNameRegistry
}

export type OrcadMigrationDormantRetirementNamespace = {
  sourceNamespaceKeys: string[]
  namespaceKey: string
  registry: RetiredNameRegistry
}

export type OrcadMigrationDormantStatePayload = {
  version: 1
  worktreeMeta: OrcadMigrationDormantWorktreeMeta[]
  worktreeLineage: OrcadMigrationDormantWorktreeLineage[]
  workspaceLineage: OrcadMigrationDormantWorkspaceLineage[]
  sparsePresets: SparsePreset[]
  retiredWorktreeNames: OrcadMigrationDormantRetiredNames[]
  retiredWorktreeNamespaces: OrcadMigrationDormantRetirementNamespace[]
  workspaceSession?: WorkspaceSessionState
  terminalScrollbackSnapshots?: OrcadMigrationTerminalScrollbackSnapshot[]
  automations?: Automation[]
  automationRuns?: AutomationRun[]
  /** Client-owned durable intent projected to the destination authority. */
  clientState?: OrcadMigrationClientStatePayload
}

export type OrcadMigrationManifest = {
  version: OrcadMigrationManifestVersion
  migrationId: string
  createdAt: string
  source: OrcadMigrationManifestSource
  payload: OrcadMigrationCatalogPayload
  /** Destination runtime identity used to re-key desktop routing after commit. */
  destinationEnvironmentId?: string
  manifestSha256: string
}

export type OrcadMigrationImportReceipt = {
  version: OrcadMigrationManifestVersion
  migrationId: string
  manifestSha256: string
  source: OrcadMigrationManifestSource
  importedAt: string
  repositoryIds: string[]
  projectGroupIds: string[]
  folderWorkspaceIds: string[]
}

export type OrcadMigrationStagedCatalog = {
  version: OrcadMigrationManifestVersion
  manifest: OrcadMigrationManifest
  stagedAt: string
}

export type OrcadMigrationCatalogState =
  | {
      state: 'absent'
      migrationId: string
      manifestSha256: string
    }
  | {
      state: 'staged'
      migrationId: string
      manifestSha256: string
      stagedAt: string
      snapshotUploads?: OrcadMigrationSnapshotUploadState[]
      /** Blobs staged so far; absent from hosts without the blob channel. */
      blobUploads?: OrcadMigrationBlobUploadState[]
    }
  | {
      state: 'committed'
      migrationId: string
      manifestSha256: string
      receipt: OrcadMigrationImportReceipt
    }

export type OrcadMigrationCatalogAbortResult = OrcadMigrationCatalogState & {
  aborted: boolean
  durableAbsent?: true
}

export function orcadMigrationManifestHashInput(
  manifest: Omit<OrcadMigrationManifest, 'manifestSha256'>
): string {
  return serializeOrcadMigrationValue(manifest)
}

export function serializeOrcadMigrationValue(value: unknown): string {
  return JSON.stringify(canonicalizeJsonValue(value))
}

function canonicalizeJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalizeJsonValue)
  }
  if (!isRecord(value)) {
    return value
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => [key, canonicalizeJsonValue(entry)])
  )
}
