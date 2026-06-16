/* oxlint-disable react-doctor/no-adjust-state-on-prop-change -- Why: setup-guide readiness is driven by bounded IPC probes and browser focus events; the state cannot be derived synchronously from render inputs. */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useAppStore } from '@/store'
import { isGitRepoKind } from '../../../../shared/repo-kind'
import { checkRuntimeHooks } from '@/runtime/runtime-hooks-client'
import { getLocalPreflightContext, localPreflightContextKey } from '@/lib/local-preflight-context'
import { hasEffectiveSetupCommand } from '@/lib/setup-script-status'
import { getProviderRuntimeContextKey } from '@/lib/provider-runtime-context'
import {
  COMPUTER_USE_SKILL_NAME,
  ORCA_CLI_SKILL_NAME,
  ORCHESTRATION_SKILL_NAME
} from '@/lib/agent-feature-install-commands'
import {
  GLOBAL_AGENT_SKILL_SOURCE_KINDS,
  useInstalledAgentSkill
} from '@/hooks/useInstalledAgentSkills'
import { useActiveProjectSkillRuntime } from '@/hooks/useActiveProjectSkillRuntime'
import {
  getFeatureWallSetupProgress,
  type FeatureWallSetupProgress
} from '../feature-wall/feature-wall-setup-progress'
import { deriveIntegrationConnectionStatus } from '../feature-wall/use-integration-connection-status'
import { useSetupGuideBrowserMilestoneProgress } from './setup-guide-browser-milestone-progress'
import {
  getComputerUsePermissionSetupState,
  getCurrentSetupScriptProbeState,
  getSetupGuideProgressReady,
  getSetupScriptProbeSignature
} from './setup-guide-progress-readiness'
import {
  readSetupScriptProbeCache,
  setSetupScriptProbeCache,
  subscribeSetupScriptProbeCache
} from './setup-script-probe-cache'

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
  const preflightStatusContextKey = useAppStore((s) => s.preflightStatusContextKey)
  const preflightStatusError = useAppStore((s) => s.preflightStatusError)
  const preflightStatusLoading = useAppStore((s) => s.preflightStatusLoading)
  const refreshPreflightStatus = useAppStore((s) => s.refreshPreflightStatus)
  const activeSkillRuntime = useActiveProjectSkillRuntime()
  const linearStatus = useAppStore((s) => s.linearStatus)
  const linearStatusChecked = useAppStore((s) => s.linearStatusChecked)
  const linearStatusContextKey = useAppStore((s) => s.linearStatusContextKey)
  const checkLinearConnection = useAppStore((s) => s.checkLinearConnection)
  const jiraStatus = useAppStore((s) => s.jiraStatus)
  const jiraStatusChecked = useAppStore((s) => s.jiraStatusChecked)
  const jiraStatusContextKey = useAppStore((s) => s.jiraStatusContextKey)
  const checkJiraConnection = useAppStore((s) => s.checkJiraConnection)
  const repos = useAppStore((s) => s.repos)
  const activeRepoId = useAppStore((s) => s.activeRepoId)
  const expectedPreflightContextKey = useAppStore((s) =>
    localPreflightContextKey(getLocalPreflightContext(s))
  )
  const setupScriptProbe = useSyncExternalStore(
    subscribeSetupScriptProbeCache,
    readSetupScriptProbeCache,
    readSetupScriptProbeCache
  )
  const [computerUsePermissionsReady, setComputerUsePermissionsReady] = useState(false)
  const [computerUsePermissionStatusChecked, setComputerUsePermissionStatusChecked] =
    useState(false)
  const [computerUseUnavailable, setComputerUseUnavailable] = useState(false)
  const { installed: detectedBrowserUseSkillInstalled, loading: detectedBrowserUseSkillLoading } =
    useInstalledAgentSkill(ORCA_CLI_SKILL_NAME, {
      enabled: shouldRefreshCoreState,
      discoveryTarget: activeSkillRuntime.discoveryTarget,
      sourceKinds: GLOBAL_AGENT_SKILL_SOURCE_KINDS
    })
  const { installed: computerUseSkillInstalled, loading: computerUseSkillLoading } =
    useInstalledAgentSkill(COMPUTER_USE_SKILL_NAME, {
      enabled: shouldRefreshCoreState,
      discoveryTarget: activeSkillRuntime.discoveryTarget,
      sourceKinds: GLOBAL_AGENT_SKILL_SOURCE_KINDS
    })
  const {
    installed: detectedOrchestrationSkillInstalled,
    loading: detectedOrchestrationSkillLoading
  } = useInstalledAgentSkill(ORCHESTRATION_SKILL_NAME, {
    enabled: shouldRefreshCoreState,
    discoveryTarget: activeSkillRuntime.discoveryTarget,
    sourceKinds: GLOBAL_AGENT_SKILL_SOURCE_KINDS
  })
  const providerRuntimeContextKey = getProviderRuntimeContextKey(settings)
  const linearStatusCurrent = linearStatusContextKey === providerRuntimeContextKey
  const jiraStatusCurrent = jiraStatusContextKey === providerRuntimeContextKey
  const preflightStatusCurrent = preflightStatusContextKey === expectedPreflightContextKey

  useEffect(() => {
    if (!shouldRefreshCoreState) {
      return
    }
    if (!preflightStatusCurrent || !preflightStatusChecked) {
      void refreshPreflightStatus()
    }
    if (!linearStatusCurrent || !linearStatusChecked) {
      void checkLinearConnection()
    }
    if (!jiraStatusCurrent || !jiraStatusChecked) {
      void checkJiraConnection()
    }
  }, [
    checkJiraConnection,
    checkLinearConnection,
    jiraStatusCurrent,
    jiraStatusChecked,
    jiraStatusContextKey,
    linearStatusCurrent,
    linearStatusChecked,
    linearStatusContextKey,
    expectedPreflightContextKey,
    preflightStatusContextKey,
    preflightStatusCurrent,
    preflightStatusChecked,
    providerRuntimeContextKey,
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
        setSetupScriptProbeCache({ signature, ready: true, hasSetupScript: false })
      }
    }, SETUP_SCRIPT_PROBE_SETTLE_TIMEOUT_MS)

    const settle = (hasSetupScript: boolean): void => {
      window.clearTimeout(timeoutId)
      if (activeSetupScriptProbeSignatureRef.current === signature) {
        setSetupScriptProbeCache({ signature, ready: true, hasSetupScript })
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
    // oxlint-disable-next-line react-doctor/no-adjust-state-on-prop-change -- Why: async permission checks update setup progress after external OS state changes.
    setComputerUsePermissionStatusChecked(true)
    setComputerUsePermissionsReady(permissionState.ready)
    setComputerUseUnavailable(permissionState.unavailable)
  }, [])

  useEffect(() => {
    if (!shouldRefreshCoreState || !computerUseSkillInstalled) {
      // Why: unavailable setup-guide steps must clear stale permission state before
      // readiness is derived for the visible checklist.
      setComputerUsePermissionStatusChecked(false)
      setComputerUsePermissionsReady(false)
      setComputerUseUnavailable(false)
      return
    }
    let stale = false
    const refreshComputerUsePermissions = (): void => {
      void readComputerUsePermissions(() => stale)
    }
    // oxlint-disable-next-line react-doctor/no-adjust-state-on-prop-change -- Why: refresh the setup checklist when the permission step becomes active.
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

  const taskSourceStatus = deriveIntegrationConnectionStatus({
    preflightStatus,
    preflightStatusChecked,
    preflightStatusContextKey,
    preflightStatusError,
    preflightStatusLoading,
    expectedPreflightContextKey,
    linearStatus,
    linearStatusChecked,
    linearStatusContextKey,
    jiraStatus,
    jiraStatusChecked,
    jiraStatusContextKey,
    providerRuntimeContextKey
  })
  const hasConnectedTaskSource = taskSourceStatus.trackerConnected
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
    // Why: task-source readiness is a capability group. Once any provider is
    // usable, unrelated stale provider checks should not hide setup progress.
    preflightStatusChecked: !taskSourceStatus.checking,
    linearStatusChecked: true,
    jiraStatusChecked: true,
    browserUseSkillDiscoveryLoading: detectedBrowserUseSkillLoading,
    computerUseSkillDiscoveryLoading: computerUseSkillLoading,
    orchestrationSkillDiscoveryLoading: detectedOrchestrationSkillLoading,
    setupScriptProbeReady: currentSetupScriptProbe.ready,
    computerUseSkillInstalled,
    computerUsePermissionStatusChecked: currentComputerUsePermissionStatusChecked
  })

  const rawProgress = useMemo(
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
  return useSetupGuideBrowserMilestoneProgress(rawProgress)
}
