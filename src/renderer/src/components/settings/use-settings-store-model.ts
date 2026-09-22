import { useCallback, useMemo, useState } from 'react'
import type { OrcaHooks } from '../../../../shared/orca-yaml-hook-types'
import type { ProjectHostSetup } from '../../../../shared/project-types'
import { DEFAULT_APP_FONT_FAMILY } from '../../../../shared/constants'
import { useAppStore } from '../../store'
import { useSystemPrefersDark } from '@/components/terminal-pane/use-system-prefers-dark'
import { isMacUserAgent, isWindowsUserAgent } from '@/components/terminal-pane/pane-helpers'
import { useConfirmationDialog } from '@/components/confirmation-dialog-context'
import { isWebClientLocation } from '@/hooks/useSettingsNavigationMetadata'
import {
  COMPUTER_USE_SKILL_NAME,
  LINEAR_AGENT_SKILL_NAMES,
  ORCHESTRATION_SKILL_NAME
} from '@/lib/agent-feature-install-commands'
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

  // Why: one entry per project (derived from repos to match nav metadata) — the source of truth for the pane list.
  const settingsProjectList = useMemo(() => buildSettingsProjectList(repos), [repos])
  const repoIdToRepresentative = useMemo(
    () => buildRepoIdToRepresentative(settingsProjectList),
    [settingsProjectList]
  )
  // Why: lets a deep-link's repoId select the owning project's host so host-specific subsection anchors exist.
  const repoIdToHostSelection = useMemo(
    () => buildRepoIdToHostSelection(settingsProjectList),
    [settingsProjectList]
  )
  // Why: pane-level "Remove Project" removes every host setup, not just the selected host (per-host remove lives in "Available Hosts").
  const removeProjectAllHosts = useCallback(
    (setups: readonly ProjectHostSetup[]): Promise<void> =>
      removeSettingsProjectFromAllHosts(setups, removeProject),
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
  // Why: mirror the nav registry's gate so the Linear sidebar entry and section appear/disappear together.
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
  const skillFreshnessApplies = activeSkillRuntime.canUseLocalSkillFreshness
  const { inventory: skillFreshnessInventory } = useSkillFreshness(skillFreshnessApplies)
  const [voiceModelStatesLoading, setVoiceModelStatesLoading] = useState(showDesktopOnlySettings)
  // Why: trim platform-only Terminal entries from the shared search index so search never reveals hidden controls.
  const [scrollbackMode, setScrollbackMode] = useState<'preset' | 'custom'>('preset')
  const [prevScrollbackRows, setPrevScrollbackRows] = useState(settings?.terminalScrollbackRows)
  // Why: keep Ghostty import state at Settings level so the modal survives section remounts.
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
  const [sourceControlAiPromptDiscardSignal, setSourceControlAiPromptDiscardSignal] = useState(0)
  const confirm = useConfirmationDialog()
  // Why: session-only (deliberately not persisted) unlock — Option-click the Experimental page title reveals the hidden group.
  const [hiddenExperimentalUnlocked, setHiddenExperimentalUnlocked] = useState(false)

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
    skillFreshnessInventory,
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
    sourceControlAiPromptDiscardSignal,
    setSourceControlAiPromptDiscardSignal,
    confirm,
    hiddenExperimentalUnlocked,
    setHiddenExperimentalUnlocked
  }
}

export type SettingsStoreModel = ReturnType<typeof useSettingsStoreModel>
