import type { GitHubWorkItem } from '../../../../shared/github/work-item-types'
import type { OrcaHooks, SetupRunPolicy } from '../../../../shared/orca-yaml-hook-types'
import type { SparsePreset } from '../../../../shared/worktree/create-types'
import type { WorkspaceLinkedItem } from '../../../../shared/worktree/types'
import type { RetiredNameRegistry } from '../../../../shared/worktree/retired-name-registry'
import type { GitHubLinkQuery } from '@/lib/github-links'
import type { SetupConfig } from '@/lib/new-workspace'

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
  setupPolicy: SetupRunPolicy
  // Why derived: this union was hand-listed and silently lagged the linked-item
  // type, so an Odoo-linked composer failed to typecheck. Deriving it means a
  // new provider cannot drift out of sync here again.
  linkedWorkItemProvider: WorkspaceLinkedItem['provider'] | null
  willApplyIssueCommandAsPrompt: boolean
  shouldWaitForIssueAutomationCheck: boolean
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
