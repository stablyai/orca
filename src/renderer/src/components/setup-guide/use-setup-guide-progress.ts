/* oxlint-disable react-doctor/no-adjust-state-on-prop-change -- Why: setup-guide readiness is driven by bounded IPC probes and browser focus events; the state cannot be derived synchronously from render inputs. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import { isGitRepoKind } from '../../../../shared/repo-kind'
import { checkRuntimeHooks } from '@/runtime/runtime-hooks-client'
import { hasEffectiveSetupCommand } from '@/lib/setup-script-status'
import {
  COMPUTER_USE_SKILL_NAME,
  ORCA_CLI_SKILL_NAME,
  ORCHESTRATION_SKILL_NAME
} from '@/lib/agent-feature-install-commands'
import {
  GLOBAL_AGENT_SKILL_SOURCE_KINDS,
  useInstalledAgentSkill
} from '@/hooks/useInstalledAgentSkills'
import {
  getFeatureWallSetupProgress,
  type FeatureWallSetupProgress
} from '../feature-wall/feature-wall-setup-progress'
import {
  getComputerUsePermissionSetupState,
  getCurrentSetupScriptProbeState,
  getSetupGuideProgressReady,
  getSetupScriptProbeSignature,
  INITIAL_SETUP_SCRIPT_PROBE_STATE,
  type SetupScriptProbeState
} from './setup-guide-progress-readiness'

const SETUP_SCRIPT_PROBE_SETTLE_TIMEOUT_MS = 15_000

export function useSetupGuideProgress(
  shouldRefreshCoreState: boolean,
  orchestrationSkillInstalled: boolean,
  browserUseSkillInstalled: boolean
): FeatureWallSetupProgress {
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
  const repos = useAppStore((s) => s.repos)
  const activeRepoId = useAppStore((s) => s.activeRepoId)
  const [setupScriptProbe, setSetupScriptProbe] = useState<SetupScriptProbeState>(
    INITIAL_SETUP_SCRIPT_PROBE_STATE
  )
  const [computerUsePermissionsReady, setComputerUsePermissionsReady] = useState(false)
  const [computerUsePermissionStatusChecked, setComputerUsePermissionStatusChecked] =
    useState(false)
  const [computerUseUnavailable, setComputerUseUnavailable] = useState(false)
  const { installed: detectedBrowserUseSkillInstalled, loading: detectedBrowserUseSkillLoading } =
    useInstalledAgentSkill(ORCA_CLI_SKILL_NAME, {
      enabled: shouldRefreshCoreState,
      sourceKinds: GLOBAL_AGENT_SKILL_SOURCE_KINDS
    })
  const { installed: computerUseSkillInstalled, loading: computerUseSkillLoading } =
    useInstalledAgentSkill(COMPUTER_USE_SKILL_NAME, {
      enabled: shouldRefreshCoreState,
      sourceKinds: GLOBAL_AGENT_SKILL_SOURCE_KINDS
    })
  const {
    installed: detectedOrchestrationSkillInstalled,
    loading: detectedOrchestrationSkillLoading
  } = useInstalledAgentSkill(ORCHESTRATION_SKILL_NAME, {
    enabled: shouldRefreshCoreState,
    sourceKinds: GLOBAL_AGENT_SKILL_SOURCE_KINDS
  })

  useEffect(() => {
    if (!shouldRefreshCoreState) {
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
    shouldRefreshCoreState
  ])

  const orderedGitRepos = useMemo(() => {
    const gitRepos = repos.filter(isGitRepoKind)
    const activeRepo = activeRepoId
      ? (gitRepos.find((repo) => repo.id === activeRepoId) ?? null)
      : null
    return activeRepo
      ? [activeRepo, ...gitRepos.filter((repo) => repo.id !== activeRepo.id)]
      : gitRepos
  }, [activeRepoId, repos])

  const setupScriptProbeSignature = useMemo(
    () => getSetupScriptProbeSignature(settings, orderedGitRepos),
    [orderedGitRepos, settings]
  )
  const activeSetupScriptProbeSignatureRef = useRef<string | null>(setupScriptProbeSignature)
  activeSetupScriptProbeSignatureRef.current = setupScriptProbeSignature

  useEffect(() => {
    if (!shouldRefreshCoreState || !settings || setupScriptProbeSignature === null) {
      return
    }
    const signature = setupScriptProbeSignature
    let stale = false
    // Why: setup-script checks can cross SSH/runtime streams. Bound sidebar
    // visibility readiness so a wedged read cannot hide the checklist forever.
    const timeoutId = window.setTimeout(() => {
      if (activeSetupScriptProbeSignatureRef.current === signature) {
        setSetupScriptProbe({ signature, ready: true, hasSetupScript: false })
      }
    }, SETUP_SCRIPT_PROBE_SETTLE_TIMEOUT_MS)

    const settle = (hasSetupScript: boolean): void => {
      window.clearTimeout(timeoutId)
      if (activeSetupScriptProbeSignatureRef.current === signature) {
        setSetupScriptProbe({ signature, ready: true, hasSetupScript })
      }
    }

    async function refreshSetupScriptState(): Promise<void> {
      for (const repo of orderedGitRepos) {
        const hooksResult = await checkRuntimeHooks(settings, repo.id).catch(() => null)
        if (stale) {
          return
        }
        if (hooksResult && hasEffectiveSetupCommand(repo, hooksResult)) {
          settle(true)
          return
        }
      }
      settle(false)
    }

    void refreshSetupScriptState()
    return () => {
      stale = true
      window.clearTimeout(timeoutId)
    }
  }, [orderedGitRepos, settings, setupScriptProbeSignature, shouldRefreshCoreState])

  const readComputerUsePermissions = useCallback(async (isStale: () => boolean): Promise<void> => {
    const status = await window.api.computerUsePermissions.getStatus().catch(() => null)
    if (isStale()) {
      return
    }
    const permissionState = getComputerUsePermissionSetupState(status)
    setComputerUsePermissionStatusChecked(true)
    setComputerUsePermissionsReady(permissionState.ready)
    setComputerUseUnavailable(permissionState.unavailable)
  }, [])

  useEffect(() => {
    if (!shouldRefreshCoreState || !computerUseSkillInstalled) {
      return
    }
    let stale = false
    const refreshComputerUsePermissions = (): void => {
      void readComputerUsePermissions(() => stale)
    }
    refreshComputerUsePermissions()
    const handleFocus = (): void => {
      void refreshComputerUsePermissions()
    }
    const handleVisibilityChange = (): void => {
      if (document.visibilityState === 'visible') {
        void refreshComputerUsePermissions()
      }
    }
    // Why: users grant Computer Use permissions outside the setup guide. Refresh
    // on return so the checklist updates without requiring a remount.
    window.addEventListener('focus', handleFocus)
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      stale = true
      window.removeEventListener('focus', handleFocus)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [computerUseSkillInstalled, readComputerUsePermissions, shouldRefreshCoreState])

  const hasConnectedTaskSource =
    (preflightStatus?.gh.installed === true && preflightStatus.gh.authenticated === true) ||
    (preflightStatus?.glab?.installed === true && preflightStatus.glab.authenticated === true) ||
    linearStatus.connected === true
  const gitRepoCount = orderedGitRepos.length
  const currentSetupScriptProbe = getCurrentSetupScriptProbeState(
    setupScriptProbe,
    setupScriptProbeSignature
  )
  const currentComputerUsePermissionStatusChecked =
    shouldRefreshCoreState && computerUseSkillInstalled ? computerUsePermissionStatusChecked : false
  const currentComputerUsePermissionsReady =
    shouldRefreshCoreState && computerUseSkillInstalled ? computerUsePermissionsReady : false
  const currentComputerUseUnavailable =
    shouldRefreshCoreState && computerUseSkillInstalled ? computerUseUnavailable : false
  const ready = getSetupGuideProgressReady({
    refreshEnabled: shouldRefreshCoreState,
    settingsLoaded: settings !== null,
    preflightStatusChecked,
    linearStatusChecked,
    browserUseSkillDiscoveryLoading: detectedBrowserUseSkillLoading,
    computerUseSkillDiscoveryLoading: computerUseSkillLoading,
    orchestrationSkillDiscoveryLoading: detectedOrchestrationSkillLoading,
    setupScriptProbeReady: currentSetupScriptProbe.ready,
    computerUseSkillInstalled,
    computerUsePermissionStatusChecked: currentComputerUsePermissionStatusChecked
  })

  return useMemo(
    () =>
      getFeatureWallSetupProgress({
        ready,
        settings,
        featureInteractions,
        hasConnectedTaskSource,
        browserUseSkillInstalled: browserUseSkillInstalled || detectedBrowserUseSkillInstalled,
        computerUseSkillInstalled,
        computerUsePermissionsReady: currentComputerUsePermissionsReady,
        computerUseUnavailable: currentComputerUseUnavailable,
        orchestrationSkillInstalled:
          orchestrationSkillInstalled || detectedOrchestrationSkillInstalled,
        gitRepoCount,
        worktreesByRepo,
        tabsByWorktree,
        terminalLayoutsByTabId,
        hasSetupScript: currentSetupScriptProbe.hasSetupScript
      }),
    [
      browserUseSkillInstalled,
      ready,
      currentComputerUseUnavailable,
      currentComputerUsePermissionsReady,
      computerUseSkillInstalled,
      detectedBrowserUseSkillInstalled,
      detectedOrchestrationSkillInstalled,
      featureInteractions,
      terminalLayoutsByTabId,
      gitRepoCount,
      hasConnectedTaskSource,
      currentSetupScriptProbe.hasSetupScript,
      orchestrationSkillInstalled,
      settings,
      tabsByWorktree,
      worktreesByRepo
    ]
  )
}
