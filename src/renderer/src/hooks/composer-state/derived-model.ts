import type { FolderSetupSupport } from '@/lib/use-folder-setup-supported'
import type { GitHubWorkItem } from '../../../../shared/github/work-item-types'
import type { OrcaHooks, SetupRunPolicy } from '../../../../shared/orca-yaml-hook-types'
import type { SparsePreset } from '../../../../shared/worktree/create-types'
import type { RetiredNameRegistry } from '../../../../shared/worktree/retired-name-registry'
import type { GitHubLinkQuery } from '../../../../shared/new-workspace/github-links'
import type { SetupConfig } from '../../../../shared/orca-hook-setup-config'

export type ComposerDerivedModel = {
  sparsePresetsForRepo: SparsePreset[]
  sparsePresets: SparsePreset[]
  normalizedSparseDirectories: string[]
  effectivePresetId: string | null
  sparseError: string | null
  parsedLinkedIssueNumber: number | null
  effectiveLinkedPR: number | null
  currentYamlHooks: OrcaHooks | null
  setupConfig: SetupConfig | null
  /** False for a folder project whose host predates folder setup; its setup controls stay hidden. */
  setupSupport: FolderSetupSupport
  setupPolicy: SetupRunPolicy
  linkedWorkItemProvider: 'github' | 'gitlab' | 'linear' | 'jira' | null
  requiresExplicitSetupChoice: boolean
  resolvedSetupDecision: 'skip' | 'run' | null
  isSetupCheckPending: boolean
  shouldWaitForSetupCheck: boolean
  retiredNamesRefreshKey: string
  retiredWorktreeNames: RetiredNameRegistry
  fallbackCreatureName: string
  workspaceSeedName: string
  shouldApplyLinkedOnlyTemplate: boolean
  linkedOnlyTemplatePrompt: string
  normalizedLinkQuery: GitHubLinkQuery
  filteredLinkItems: GitHubWorkItem[]
}
