import { useCallback, useMemo, useState } from 'react'
import type { OrcaHooks } from '../../../../shared/orca-yaml-hook-types'
import type { ProjectHostSetup } from '../../../../shared/project-types'
import { DEFAULT_APP_FONT_FAMILY } from '../../../../shared/constants'
import { useAppStore } from '../../store'
import { useProjectHostSetupProjection } from '@/store/selectors'
import { useSystemPrefersDark } from '@/components/terminal-pane/use-system-prefers-dark'
import { isMacUserAgent, isWindowsUserAgent } from '@/components/terminal-pane/pane-helpers'
import { useConfirmationDialog } from '@/components/confirmation-dialog-context'
import { isWebClientLocation } from '@/hooks/useSettingsNavigationMetadata'
import {
  COMPUTER_USE_SKILL_NAME,
  LINEAR_AGENT_SKILL_NAMES,
  ORCHESTRATION_SKILL_NAME
} from '@/lib/agent-feature-skill-names'
import {
  GLOBAL_AGENT_SKILL_SOURCE_KINDS,
  useInstalledAgentSkill,
  useInstalledAgentSkillNames
} from '@/hooks/useInstalledAgentSkills'
import { useActiveProjectSkillRuntime } from '@/hooks/useActiveProjectSkillRuntime'
import { useLinearProviderConnected } from '@/hooks/useLinearProviderConnected'
import { useSkillFreshness } from '@/hooks/useSkillFreshness'
import { getFallbackTerminalFonts, mergeFontSuggestions } from './SettingsConstants'
import { useGhosttyImport } from './useGhosttyImport'
import { useWarpThemeImport } from './useWarpThemeImport'
import { getInitialMountedSectionIds } from './settings-load-performance'
import {
  buildRepoIdToHostSelection,
  buildRepoIdToRepresentative,
  buildSettingsProjectList,
  removeSettingsProjectFromAllHosts
} from './settings-project-list'
import { resolveSettingsHostScope } from './settings-host-scope'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { defaultScopeHost } from '@/lib/default-creation-host'
import {
  blockRemovalForUnsavedFiles,
  projectRemovalTargets
} from '@/components/sidebar/removal-unsaved-files'

export function useSettingsStoreModel() {
  const settings = useAppStore((s) => s.settings)
  const keybindings = useAppStore((s) => s.keybindings)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const updateSettingsOrThrow = useAppStore((s) => s.updateSettingsOrThrow)
  const setActiveRuntimeEnvironmentPreference = useAppStore(
    (s) => s.setActiveRuntimeEnvironmentPreference
  )
  const fetchSettings = useAppStore((s) => s.fetchSettings)
  const fetchKeybindings = useAppStore((s) => s.fetchKeybindings)
  const closeSettingsPage = useAppStore((s) => s.closeSettingsPage)
  const repos = useAppStore((s) => s.repos)
  const projects = useAppStore((s) => s.projects)
  const projectHostSetups = useAppStore((s) => s.projectHostSetups)
  const updateProject = useAppStore((s) => s.updateProject)
  const updateRepo = useAppStore((s) => s.updateRepo)
  const removeProject = useAppStore((s) => s.removeProject)
  const settingsNavigationTarget = useAppStore((s) => s.settingsNavigationTarget)
  const clearSettingsTarget = useAppStore((s) => s.clearSettingsTarget)
  const settingsProjectHostSelection = useAppStore((s) => s.settingsProjectHostSelection)
  const settingsProjectSetupSelection = useAppStore((s) => s.settingsProjectSetupSelection)
  const setSettingsProjectHostSelection = useAppStore((s) => s.setSettingsProjectHostSelection)
  const settingsSearchQuery = useAppStore((s) => s.settingsSearchQuery)
  const setSettingsSearchQuery = useAppStore((s) => s.setSettingsSearchQuery)
  const modelStates = useAppStore((s) => s.modelStates)
  const refreshModelStates = useAppStore((s) => s.refreshModelStates)
  const runtimeEnvironments = useAppStore((s) => s.runtimeEnvironments)
  const runtimeEnvironmentCatalogHydrated = useAppStore((s) => s.runtimeEnvironmentCatalogHydrated)

  const projectHostSetupProjection = useProjectHostSetupProjection()
  // Use navigation’s grouping inputs so pane and navigation lists agree.
  const settingsProjectList = useMemo(
    () =>
      buildSettingsProjectList(repos, {
        projects: projectHostSetupProjection.projects,
        projectHostSetups: projectHostSetupProjection.setups
      }),
    [repos, projectHostSetupProjection]
  )
  const repoIdToRepresentative = useMemo(
    () => buildRepoIdToRepresentative(settingsProjectList),
    [settingsProjectList]
  )
  // Deep links must choose the repo’s host before host-specific anchors render.
  const repoIdToHostSelection = useMemo(
    () => buildRepoIdToHostSelection(settingsProjectList),
    [settingsProjectList]
  )
  // Remove the entry’s setups on every host; split clones own separate entries.
  const removeProjectAllHosts = useCallback(
    async (setups: readonly ProjectHostSetup[]): Promise<void> => {
      // Block dirty removals because this confirmation cannot list files and leaves folders on disk.
      const targets = projectRemovalTargets(
        useAppStore.getState(),
        setups.map((setup) => ({ repoId: setup.repoId, hostId: setup.hostId }))
      )
      const name = setups[0]?.displayName ?? ''
      if (!blockRemovalForUnsavedFiles(useAppStore.getState, targets, name)) {
        await removeSettingsProjectFromAllHosts(setups, removeProject)
      }
    },
    [removeProject]
  )

  const [repoHooksMap, setRepoHooksMap] = useState<
    Record<string, { hasHooks: boolean; hooks: OrcaHooks | null; mayNeedUpdate: boolean }>
  >({})
  const systemPrefersDark = useSystemPrefersDark()
  const isWindows = isWindowsUserAgent()
  const isMac = isMacUserAgent()
  const isWebClient = isWebClientLocation()
  const showDesktopOnlySettings = !isWebClient
  // Match navigation’s gate so the Linear entry and pane appear together.
  const linearConnected = useLinearProviderConnected()
  const activeSkillRuntime = useActiveProjectSkillRuntime()
  const orchestrationSkill = useInstalledAgentSkill(ORCHESTRATION_SKILL_NAME, {
    discoveryTarget: activeSkillRuntime.discoveryTarget,
    sourceKinds: GLOBAL_AGENT_SKILL_SOURCE_KINDS
  })
  const linearSkill = useInstalledAgentSkillNames(LINEAR_AGENT_SKILL_NAMES, {
    enabled: linearConnected,
    discoveryTarget: activeSkillRuntime.discoveryTarget,
    sourceKinds: GLOBAL_AGENT_SKILL_SOURCE_KINDS
  })
  const computerUseSkill = useInstalledAgentSkill(COMPUTER_USE_SKILL_NAME, {
    enabled: showDesktopOnlySettings,
    discoveryTarget: activeSkillRuntime.discoveryTarget,
    sourceKinds: GLOBAL_AGENT_SKILL_SOURCE_KINDS
  })
  const skillFreshnessApplies = activeSkillRuntime.bundledSkillTarget !== null
  const { plan: skillPlan } = useSkillFreshness(activeSkillRuntime.bundledSkillTarget)
  const [voiceModelStatesLoading, setVoiceModelStatesLoading] = useState(showDesktopOnlySettings)
  const [scrollbackMode, setScrollbackMode] = useState<'preset' | 'custom'>('preset')
  const [prevScrollbackRows, setPrevScrollbackRows] = useState(settings?.terminalScrollbackRows)
  // Keep import state above sections so remounts cannot close the modal.
  const ghostty = useGhosttyImport(updateSettings, settings)
  const warpThemes = useWarpThemeImport(updateSettings, settings)
  const [fontSuggestions, setFontSuggestions] = useState<string[]>(
    mergeFontSuggestions([], getFallbackTerminalFonts())
  )
  const terminalFontSuggestions = useMemo(
    () => fontSuggestions.filter((font) => font !== DEFAULT_APP_FONT_FAMILY),
    [fontSuggestions]
  )
  const [activeSectionId, setActiveSectionId] = useState('general')
  const [mountedSectionIds, setMountedSectionIds] = useState<Set<string>>(
    getInitialMountedSectionIds
  )
  const [pendingNavRequestTick, setPendingNavRequestTick] = useState(0)
  const [highlightedSettingsTargetId, setHighlightedSettingsTargetId] = useState<string | null>(
    null
  )
  const [quickCommandAddIntentSignal, setQuickCommandAddIntentSignal] = useState(0)
  const [sshHostAddIntentSignal, setSshHostAddIntentSignal] = useState(0)
  const [remoteServerAddIntentSignal, setRemoteServerAddIntentSignal] = useState(0)
  const [hasUnsavedCommitPromptChanges, setHasUnsavedCommitPromptChanges] = useState(false)
  const [hasUnsavedBranchPromptChanges, setHasUnsavedBranchPromptChanges] = useState(false)
  const [hasUnsavedChatPromptChanges, setHasUnsavedChatPromptChanges] = useState(false)
  const [sourceControlAiPromptDiscardSignal, setSourceControlAiPromptDiscardSignal] = useState(0)
  const confirm = useConfirmationDialog()
  // Option-click unlocks hidden experiments for this session only.
  const [hiddenExperimentalUnlocked, setHiddenExperimentalUnlocked] = useState(false)
  const [settingsHostChoice, setSettingsHostChoice] = useState<RuntimeClientTarget | null>(null)
  const defaultScope = defaultScopeHost(settings)
  const defaultRuntimeEnvironmentId =
    defaultScope.kind === 'environment' ? defaultScope.environmentId : null
  // Key by IDs so status-only catalog changes cannot restart host-scoped loads.
  const savedEnvironmentIdsKey = runtimeEnvironments.map((environment) => environment.id).join('\n')
  // Web clients use their serving host and cannot offer host selection.
  const settingsHostScope = useMemo(
    () =>
      resolveSettingsHostScope({
        choice: isWebClient ? null : settingsHostChoice,
        defaultEnvironmentId: defaultRuntimeEnvironmentId,
        savedEnvironmentIds: savedEnvironmentIdsKey ? savedEnvironmentIdsKey.split('\n') : [],
        catalogHydrated: runtimeEnvironmentCatalogHydrated
      }),
    [
      defaultRuntimeEnvironmentId,
      isWebClient,
      runtimeEnvironmentCatalogHydrated,
      savedEnvironmentIdsKey,
      settingsHostChoice
    ]
  )

  return {
    settings,
    keybindings,
    updateSettings,
    updateSettingsOrThrow,
    setActiveRuntimeEnvironmentPreference,
    fetchSettings,
    fetchKeybindings,
    closeSettingsPage,
    repos,
    projects,
    projectHostSetups,
    updateProject,
    updateRepo,
    settingsNavigationTarget,
    clearSettingsTarget,
    settingsProjectHostSelection,
    settingsProjectSetupSelection,
    setSettingsProjectHostSelection,
    settingsSearchQuery,
    setSettingsSearchQuery,
    modelStates,
    refreshModelStates,
    settingsProjectList,
    repoIdToRepresentative,
    repoIdToHostSelection,
    removeProjectAllHosts,
    repoHooksMap,
    setRepoHooksMap,
    systemPrefersDark,
    isWindows,
    isMac,
    isWebClient,
    showDesktopOnlySettings,
    linearConnected,
    orchestrationSkill,
    linearSkill,
    computerUseSkill,
    skillFreshnessApplies,
    skillPlan,
    voiceModelStatesLoading,
    setVoiceModelStatesLoading,
    scrollbackMode,
    setScrollbackMode,
    prevScrollbackRows,
    setPrevScrollbackRows,
    ghostty,
    warpThemes,
    fontSuggestions,
    setFontSuggestions,
    terminalFontSuggestions,
    activeSectionId,
    setActiveSectionId,
    mountedSectionIds,
    setMountedSectionIds,
    pendingNavRequestTick,
    setPendingNavRequestTick,
    highlightedSettingsTargetId,
    setHighlightedSettingsTargetId,
    quickCommandAddIntentSignal,
    setQuickCommandAddIntentSignal,
    sshHostAddIntentSignal,
    setSshHostAddIntentSignal,
    remoteServerAddIntentSignal,
    setRemoteServerAddIntentSignal,
    hasUnsavedCommitPromptChanges,
    setHasUnsavedCommitPromptChanges,
    hasUnsavedBranchPromptChanges,
    setHasUnsavedBranchPromptChanges,
    hasUnsavedChatPromptChanges,
    setHasUnsavedChatPromptChanges,
    sourceControlAiPromptDiscardSignal,
    setSourceControlAiPromptDiscardSignal,
    confirm,
    hiddenExperimentalUnlocked,
    setHiddenExperimentalUnlocked,
    runtimeEnvironments,
    settingsHostScope,
    setSettingsHostChoice
  }
}

export type SettingsStoreModel = ReturnType<typeof useSettingsStoreModel>
