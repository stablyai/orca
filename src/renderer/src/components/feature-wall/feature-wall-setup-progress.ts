import type { FeatureInteractionState } from '../../../../shared/feature-interactions'
import {
  FEATURE_WALL_SETUP_STEPS,
  type FeatureWallSetupStepId
} from '../../../../shared/feature-wall-setup-steps'
import type {
  GlobalSettings,
  TerminalLayoutSnapshot,
  TerminalPaneLayoutNode,
  TerminalTab,
  Worktree
} from '../../../../shared/types'

export type FeatureWallSetupProgressInput = {
  settings: GlobalSettings | null
  featureInteractions: FeatureInteractionState
  hasConnectedTaskSource: boolean
  browserUseSkillInstalled: boolean
  computerUseSkillInstalled: boolean
  computerUsePermissionsReady: boolean
  computerUseUnavailable?: boolean
  orchestrationSkillInstalled: boolean
  gitRepoCount: number
  worktreesByRepo: Record<string, Worktree[]>
  tabsByWorktree: Record<string, TerminalTab[]>
  terminalLayoutsByTabId: Record<string, TerminalLayoutSnapshot>
  hasSetupScript: boolean
}

export type FeatureWallSetupProgress = {
  stepDone: Record<FeatureWallSetupStepId, boolean>
  coreDoneCount: number
  coreTotal: number
}

function isSplitLayout(node: TerminalPaneLayoutNode | null | undefined): boolean {
  // A split node means the tab holds 2+ panes, regardless of what runs in them.
  return Boolean(node) && node!.type === 'split'
}

function hasSplitTerminalInAnyWorktree(input: FeatureWallSetupProgressInput): boolean {
  const validWorktreeIds = new Set(
    Object.values(input.worktreesByRepo)
      .flat()
      .map((worktree) => worktree.id)
  )
  for (const [worktreeId, tabs] of Object.entries(input.tabsByWorktree)) {
    if (!validWorktreeIds.has(worktreeId)) {
      continue
    }
    for (const tab of tabs) {
      if (isSplitLayout(input.terminalLayoutsByTabId[tab.id]?.root)) {
        return true
      }
    }
  }
  return false
}

function countAvailableNonMainWorktrees(worktreesByRepo: Record<string, Worktree[]>): number {
  // Why: imported git worktrees count as real parallel-work capacity, but
  // partially hydrated placeholders can appear before a worktree path is known.
  return Object.values(worktreesByRepo).reduce(
    (sum, worktrees) =>
      sum +
      worktrees.filter(
        (worktree) => !worktree.isMainWorktree && typeof worktree.path === 'string' && worktree.path
      ).length,
    0
  )
}

export function getFeatureWallSetupProgress(
  input: FeatureWallSetupProgressInput
): FeatureWallSetupProgress {
  const agentCapabilitiesDone =
    input.browserUseSkillInstalled &&
    input.computerUseSkillInstalled &&
    (input.computerUsePermissionsReady || input.computerUseUnavailable === true) &&
    input.orchestrationSkillInstalled
  const stepDone: Record<FeatureWallSetupStepId, boolean> = {
    'default-agent':
      Boolean(input.settings?.defaultTuiAgent) && input.settings?.defaultTuiAgent !== 'blank',
    'add-two-repos': input.gitRepoCount >= 2,
    notifications:
      input.settings?.notifications.enabled === true &&
      input.settings.notifications.agentTaskComplete === true,
    'split-terminal': hasSplitTerminalInAnyWorktree(input),
    'two-worktrees': countAvailableNonMainWorktrees(input.worktreesByRepo) >= 1,
    'task-sources': input.hasConnectedTaskSource,
    'agent-capabilities': agentCapabilitiesDone,
    'setup-script': input.hasSetupScript
  }
  return {
    stepDone,
    coreDoneCount: FEATURE_WALL_SETUP_STEPS.filter((step) => stepDone[step.id]).length,
    coreTotal: FEATURE_WALL_SETUP_STEPS.length
  }
}
