import { useEffect } from 'react'
import type { FeatureWallWorkflow } from '../../../../shared/feature-wall-workflows'
import { useAppStore } from '@/store'

export type FeatureWallTaskSourcePresentation = {
  workflow: FeatureWallWorkflow
  hasConnectedTaskSource: boolean
  // True until the first preflight + Linear status check has resolved. Callers
  // should treat unknown state as "don't show the disconnected setup affordance
  // yet" so we don't flash inline integration rows for a connected user.
  isCheckingTaskSources: boolean
}

export function useFeatureWallTaskSourcePresentation(
  isOpen: boolean,
  selected: FeatureWallWorkflow
): FeatureWallTaskSourcePresentation {
  const preflightStatus = useAppStore((s) => s.preflightStatus)
  const preflightStatusChecked = useAppStore((s) => s.preflightStatusChecked)
  const preflightStatusLoading = useAppStore((s) => s.preflightStatusLoading)
  const refreshPreflightStatus = useAppStore((s) => s.refreshPreflightStatus)
  const linearStatus = useAppStore((s) => s.linearStatus)
  const linearStatusChecked = useAppStore((s) => s.linearStatusChecked)
  const checkLinearConnection = useAppStore((s) => s.checkLinearConnection)

  useEffect(() => {
    if (!isOpen) {
      return
    }
    // Why: the Tasks tour copy depends on whether a task source is already
    // usable, so connected users should not see setup-oriented guidance.
    if (!preflightStatusChecked) {
      void refreshPreflightStatus()
    }
    if (!linearStatusChecked) {
      void checkLinearConnection()
    }
  }, [
    checkLinearConnection,
    isOpen,
    linearStatusChecked,
    preflightStatusChecked,
    refreshPreflightStatus
  ])

  const hasConnectedTaskSource =
    (preflightStatus?.gh.installed === true && preflightStatus.gh.authenticated === true) ||
    (preflightStatus?.glab?.installed === true && preflightStatus.glab.authenticated === true) ||
    linearStatus.connected === true
  const isCheckingTaskSources =
    preflightStatusLoading || !preflightStatusChecked || !linearStatusChecked

  return { workflow: selected, hasConnectedTaskSource, isCheckingTaskSources }
}
