import { useEffect, useMemo } from 'react'
import type { FeatureWallSetupStepId } from '../../../../shared/feature-wall-setup-steps'
import { useAppStore } from '@/store'
import { getFeatureWallSetupProgress } from '../feature-wall/feature-wall-setup-progress'

export const SETTINGS_SETUP_GUIDE_STEP_IDS = [
  'split-terminal',
  'two-worktrees',
  'notifications',
  'default-agent',
  'task-sources'
] as const satisfies readonly FeatureWallSetupStepId[]

export type SettingsSetupGuideProgress = {
  doneCount: number
  total: number
  firstIncompleteStepId: FeatureWallSetupStepId | null
}

export function getSettingsSetupGuideProgress(
  stepDone: Partial<Record<FeatureWallSetupStepId, boolean>>
): SettingsSetupGuideProgress {
  const doneCount = SETTINGS_SETUP_GUIDE_STEP_IDS.filter((stepId) => stepDone[stepId]).length
  const firstIncompleteStepId =
    SETTINGS_SETUP_GUIDE_STEP_IDS.find((stepId) => !stepDone[stepId]) ?? null

  return {
    doneCount,
    total: SETTINGS_SETUP_GUIDE_STEP_IDS.length,
    firstIncompleteStepId
  }
}

export function useSettingsSetupGuideProgress(
  shouldRefreshTaskSourceState: boolean
): SettingsSetupGuideProgress {
  const settings = useAppStore((s) => s.settings)
  const featureInteractions = useAppStore((s) => s.featureInteractions)
  const worktreesByRepo = useAppStore((s) => s.worktreesByRepo)
  const tabsByWorktree = useAppStore((s) => s.tabsByWorktree)
  const terminalLayoutsByTabId = useAppStore((s) => s.terminalLayoutsByTabId)
  const preflightStatus = useAppStore((s) => s.preflightStatus)
  const preflightStatusChecked = useAppStore((s) => s.preflightStatusChecked)
  const refreshPreflightStatus = useAppStore((s) => s.refreshPreflightStatus)
  const linearStatus = useAppStore((s) => s.linearStatus)
  const linearStatusChecked = useAppStore((s) => s.linearStatusChecked)
  const checkLinearConnection = useAppStore((s) => s.checkLinearConnection)

  useEffect(() => {
    if (!shouldRefreshTaskSourceState) {
      return
    }
    if (!preflightStatusChecked) {
      void refreshPreflightStatus()
    }
    if (!linearStatusChecked) {
      void checkLinearConnection()
    }
  }, [
    checkLinearConnection,
    linearStatusChecked,
    preflightStatusChecked,
    refreshPreflightStatus,
    shouldRefreshTaskSourceState
  ])

  const hasConnectedTaskSource =
    (preflightStatus?.gh.installed === true && preflightStatus.gh.authenticated === true) ||
    (preflightStatus?.glab?.installed === true && preflightStatus.glab.authenticated === true) ||
    linearStatus.connected === true

  return useMemo(() => {
    // Why: Settings renders only five steps, so avoid the full setup guide
    // probes for setup scripts and agent skills, especially over SSH.
    const fullProgress = getFeatureWallSetupProgress({
      settings,
      featureInteractions,
      hasConnectedTaskSource,
      browserUseSkillInstalled: false,
      computerUseSkillInstalled: false,
      computerUsePermissionsReady: false,
      orchestrationSkillInstalled: false,
      gitRepoCount: 0,
      worktreesByRepo,
      tabsByWorktree,
      terminalLayoutsByTabId,
      hasSetupScript: false
    })
    return getSettingsSetupGuideProgress(fullProgress.stepDone)
  }, [
    featureInteractions,
    hasConnectedTaskSource,
    settings,
    tabsByWorktree,
    terminalLayoutsByTabId,
    worktreesByRepo
  ])
}
