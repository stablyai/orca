import type * as React from 'react'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { GitPushTarget } from '../../../../shared/worktree/types'
import type { SmartNameMode } from '@/components/new-workspace/smart-workspace-source-results'

export type ComposerIdentityModel = {
  linkedIssue: string
  setLinkedIssue: React.Dispatch<React.SetStateAction<string>>
  linkedPR: number | null
  setLinkedPR: React.Dispatch<React.SetStateAction<number | null>>
  linkedGitLabIssue: number | null
  setLinkedGitLabIssue: React.Dispatch<React.SetStateAction<number | null>>
  linkedGitLabMR: number | null
  setLinkedGitLabMR: React.Dispatch<React.SetStateAction<number | null>>
  baseBranch: string | undefined
  setBaseBranch: React.Dispatch<React.SetStateAction<string | undefined>>
  compareBaseRef: string | undefined
  setCompareBaseRef: React.Dispatch<React.SetStateAction<string | undefined>>
  branchNameOverride: string | undefined
  setBranchNameOverride: React.Dispatch<React.SetStateAction<string | undefined>>
  parentWorktreeId: string | null
  setParentWorktreeId: React.Dispatch<React.SetStateAction<string | null>>
  branchNameOverridePreservesNameEdits: boolean
  setBranchNameOverridePreservesNameEdits: React.Dispatch<React.SetStateAction<boolean>>
  smartNameMode: SmartNameMode
  setSmartNameMode: React.Dispatch<React.SetStateAction<SmartNameMode>>
  sourceIntentBlocksCreate: boolean
  reuseEligibleBranch: string | null
  setReuseEligibleBranch: React.Dispatch<React.SetStateAction<string | null>>
  reuseSelectedBranch: boolean
  setReuseSelectedBranch: React.Dispatch<React.SetStateAction<boolean>>
  pushTarget: GitPushTarget | undefined
  setPushTarget: React.Dispatch<React.SetStateAction<GitPushTarget | undefined>>
  startFromResetHint: string | null
  setStartFromResetHint: React.Dispatch<React.SetStateAction<string | null>>
  forkPushWarning: string | null
  setForkPushWarning: React.Dispatch<React.SetStateAction<string | null>>
  disabledTuiAgentKey: string
  disabledTuiAgents: TuiAgent[]
  enabledCatalogAgents: TuiAgent[]
  fallbackDefaultAgent: TuiAgent
  tuiAgent: TuiAgent
  setTuiAgent: React.Dispatch<React.SetStateAction<TuiAgent>>
  connectionId: string | null
  isRemote: boolean
  runtimeEnvironmentId: string | null
  detectedAgentList: TuiAgent[] | null
  ensureDetectedAgents: (worktreeId?: string | null) => Promise<TuiAgent[]>
  ensureRemoteDetectedAgents: (
    connectionId: string,
    options?: { force?: boolean }
  ) => Promise<TuiAgent[]>
  ensureRuntimeDetectedAgents: (environmentId: string) => Promise<TuiAgent[]>
  detectedAgentIds: Set<TuiAgent> | null
}
